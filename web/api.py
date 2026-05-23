import hashlib
import hmac
import json
import logging
import re
import time
from urllib.parse import parse_qsl

from fastapi import APIRouter, Depends, Header, HTTPException, status
from pydantic import BaseModel
from typing import List, Dict, Any, Optional

from config import config
from db.database import get_db_connection
from services.haproxy_manager import haproxy_manager
from services.marzban import marzban_manager
from services.ssh_manager import ssh_manager

logger = logging.getLogger(__name__)

TELEGRAM_INIT_DATA_MAX_AGE_SECONDS = 24 * 60 * 60


def _validate_telegram_init_data(init_data: str) -> Dict[str, Any]:
    """
    Проверяет подпись Telegram WebApp initData согласно документации Telegram.
    Возвращает распарсенный user-объект при успешной проверке.
    """
    parsed_pairs = parse_qsl(init_data, keep_blank_values=True)
    if not parsed_pairs:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Отсутствуют параметры Telegram initData.",
        )

    data: Dict[str, str] = {}
    received_hash: Optional[str] = None

    for key, value in parsed_pairs:
        if key == "hash":
            received_hash = value
        else:
            data[key] = value

    if not received_hash:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Отсутствует hash в Telegram initData.",
        )

    data_check_string = "\n".join(f"{k}={v}" for k, v in sorted(data.items()))
    secret_key = hmac.new(
        b"WebAppData",
        config.BOT_TOKEN.encode("utf-8"),
        hashlib.sha256,
    ).digest()
    calculated_hash = hmac.new(
        secret_key,
        data_check_string.encode("utf-8"),
        hashlib.sha256,
    ).hexdigest()

    if not hmac.compare_digest(calculated_hash, received_hash):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Невалидная подпись Telegram initData.",
        )

    auth_date_raw = data.get("auth_date")
    if auth_date_raw:
        try:
            auth_date = int(auth_date_raw)
        except ValueError as exc:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Некорректный auth_date в Telegram initData.",
            ) from exc

        if abs(int(time.time()) - auth_date) > TELEGRAM_INIT_DATA_MAX_AGE_SECONDS:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Telegram initData устарел. Откройте Mini App заново из бота.",
            )

    user_raw = data.get("user")
    if not user_raw:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="В Telegram initData нет user-данных.",
        )

    try:
        user = json.loads(user_raw)
    except json.JSONDecodeError as exc:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Не удалось распарсить user из Telegram initData.",
        ) from exc

    return user


async def require_telegram_admin(
    x_telegram_init_data: Optional[str] = Header(default=None, alias="X-Telegram-Init-Data"),
) -> Dict[str, Any]:
    """
    Гейт авторизации для Mini App API:
    - запрос должен прийти из Telegram Mini App (initData)
    - подпись initData должна быть валидна
    - пользователь должен совпадать с ADMIN_ID из env
    """
    if config.ADMIN_ID <= 0:
        logger.error("ADMIN_ID не настроен, API заблокирован.")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="ADMIN_ID не настроен на сервере.",
        )

    if not x_telegram_init_data:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Требуется Telegram initData. Откройте панель через кнопку бота.",
        )

    user = _validate_telegram_init_data(x_telegram_init_data)
    user_id = int(user.get("id", 0))

    if user_id != config.ADMIN_ID:
        logger.warning("Доступ запрещен: user_id=%s, ADMIN_ID=%s", user_id, config.ADMIN_ID)
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Доступ запрещен: вы не администратор.",
        )

    return user


router = APIRouter(
    prefix="/api",
    tags=["MiniApp API"],
    dependencies=[Depends(require_telegram_admin)],
)

# --- Pydantic Модели ---
class NodeCreate(BaseModel):
    ip: str
    role: str
    billing_date: str
    ssh_key: Optional[str] = None

class HAProxyUpdate(BaseModel):
    ip: str
    config_content: Optional[str] = None
    # Backward compatibility with the current frontend bundle:
    # it sends "config" instead of "config_content".
    config: Optional[str] = None


class SysinfoRequest(BaseModel):
    ip: str

# --- Эндпоинты ---

@router.get("/nodes", response_model=List[Dict[str, Any]])
async def get_nodes() -> List[Dict[str, Any]]:
    """Получение списка всех серверов кластера."""
    try:
        async with get_db_connection() as db:
            async with db.execute("SELECT id, ip, role, billing_date, status, ssh_key FROM nodes") as cursor:
                rows = await cursor.fetchall()
                result = []
                for row in rows:
                    node_dict = dict(row)
                    # Скрываем приватный ключ в целях безопасности
                    node_dict["has_ssh_key"] = bool(node_dict.get("ssh_key"))
                    node_dict.pop("ssh_key", None)
                    result.append(node_dict)
                return result
    except Exception as e:
        logger.error(f"Ошибка при получении нод: {e}")
        raise HTTPException(status_code=500, detail="Ошибка базы данных")

@router.post("/nodes")
async def add_node(node: NodeCreate) -> Dict[str, str]:
    """Добавление новой ноды в инвентарь."""
    try:
        # Если ключ не предоставлен, сгенерируем уникальный SSH-ключ для этой ноды
        final_ssh_key = node.ssh_key
        if not final_ssh_key:
            import asyncssh
            generated = asyncssh.generate_private_key('ssh-rsa', key_size=2048)
            final_ssh_key = generated.export_private_key().decode('utf-8')

        async with get_db_connection() as db:
            await db.execute(
                "INSERT INTO nodes (ip, role, billing_date, ssh_key) VALUES (?, ?, ?, ?)",
                (node.ip, node.role, node.billing_date, final_ssh_key)
            )
            await db.commit()
        return {"status": "success", "message": f"Нода {node.ip} добавлена."}
    except Exception as e:
        logger.error(f"Ошибка при добавлении ноды {node.ip}: {e}")
        raise HTTPException(status_code=400, detail="Ошибка при добавлении (возможно IP уже существует)")

@router.post("/haproxy/apply")
async def apply_haproxy_config(data: HAProxyUpdate) -> Dict[str, str]:
    """
    Применение нового конфига HAProxy на указанной ноде.
    Использует HAProxyManager для безопасного деплоя с откатом.
    """
    logger.info(f"Запрос на обновление HAProxy для {data.ip}")

    config_content = (data.config_content or data.config or "").strip()
    if not config_content:
        raise HTTPException(
            status_code=400,
            detail="Пустая конфигурация: передайте 'config_content' (или 'config' для совместимости).",
        )

    success, message = await haproxy_manager.apply_config(data.ip, config_content)
    
    if success:
        return {"status": "success", "message": message}
    else:
        # Возвращаем 400 с текстом ошибки (например, синтаксической), чтобы показать в UI
        raise HTTPException(status_code=400, detail=message)


@router.post("/sysinfo")
async def get_sysinfo(data: SysinfoRequest) -> Dict[str, Any]:
    """
    Выполняет базовую диагностику ноды и возвращает логи строками для UI.
    """
    command = (
        "echo '[INFO] Connecting...' ; "
        "echo '--- UPTIME ---'; uptime; "
        "echo '--- RAM ---'; free -m; "
        "echo '--- DISK ---'; df -h /"
    )
    success, result = await ssh_manager.execute_command(data.ip, command, timeout=25)
    if not success:
        raise HTTPException(status_code=400, detail=result)

    logs = [line for line in result.splitlines() if line.strip()]
    return {"ip": data.ip, "logs": logs}


@router.get("/marzban/stats")
async def get_marzban_stats() -> Dict[str, Any]:
    """
    Возвращает агрегированную статистику для вкладки Marzban:
    - top_users
    - anomalies (эвристические предупреждения)
    """
    users = await marzban_manager.get_users()
    if not users:
        return {"anomalies": [], "top_users": []}

    active_users = [u for u in users if u.get("status") == "active"]
    sorted_users = sorted(active_users, key=lambda x: x.get("used_traffic", 0), reverse=True)

    top_users: List[Dict[str, Any]] = []
    anomalies: List[Dict[str, Any]] = []

    for idx, user in enumerate(sorted_users[:10], start=1):
        username = str(user.get("username", "unknown"))
        used_traffic = int(user.get("used_traffic", 0) or 0)
        status = str(user.get("status", "unknown"))
        used_gb = round(used_traffic / (1024 ** 3), 2)

        top_users.append(
            {
                "username": username,
                "traffic": f"{used_gb} GB",
                "status": status,
                "used_bytes": used_traffic,
            }
        )

        data_limit = user.get("data_limit")
        if data_limit:
            try:
                limit_int = int(data_limit)
            except (TypeError, ValueError):
                limit_int = 0

            if limit_int > 0:
                usage_ratio = used_traffic / limit_int
                if usage_ratio >= 0.95:
                    anomalies.append(
                        {
                            "id": f"limit-{idx}",
                            "text": f"Пользователь {username} израсходовал {round(usage_ratio * 100, 1)}% лимита.",
                            "severity": "high",
                        }
                    )
                elif usage_ratio >= 0.85:
                    anomalies.append(
                        {
                            "id": f"limit-{idx}",
                            "text": f"Пользователь {username} приближается к лимиту ({round(usage_ratio * 100, 1)}%).",
                            "severity": "medium",
                        }
                    )

    return {"anomalies": anomalies, "top_users": top_users[:5]}


@router.get("/security/audit")
async def get_security_audit() -> Dict[str, Any]:
    """
    Возвращает:
    - список забаненных IP (по UFW на ingress-нодах)
    - недавние SSH события (Accepted/Rejected)
    """
    async with get_db_connection() as db:
        async with db.execute("SELECT ip FROM nodes WHERE role = 'ingress' AND status = 'active'") as cursor:
            ingress_nodes = await cursor.fetchall()
        async with db.execute("SELECT ip FROM nodes WHERE status = 'active'") as cursor:
            all_nodes = await cursor.fetchall()

    banned_ips: List[Dict[str, str]] = []
    ssh_logins: List[Dict[str, str]] = []

    for node in ingress_nodes:
        node_ip = node["ip"]
        success, output = await ssh_manager.execute_command(
            node_ip,
            "ufw status | grep 'DENY IN' || true",
            timeout=15,
        )
        if not success:
            continue

        for line in output.splitlines():
            line = line.strip()
            if not line:
                continue
            match = re.search(r"(\d{1,3}(?:\.\d{1,3}){3})", line)
            if not match:
                continue
            banned_ips.append(
                {
                    "ip": match.group(1),
                    "reason": "UFW DENY IN",
                    "date": "latest",
                }
            )

    for node in all_nodes:
        node_ip = node["ip"]
        success, output = await ssh_manager.execute_command(
            node_ip,
            "journalctl -u ssh --since '24 hours ago' | grep -E 'Accepted|Failed password|Invalid user' | tail -n 20 || true",
            timeout=20,
        )
        if not success:
            continue

        for line in output.splitlines():
            raw = line.strip()
            if not raw:
                continue
            source_match = re.search(r"from (\d{1,3}(?:\.\d{1,3}){3})", raw)
            source_ip = source_match.group(1) if source_match else "Unknown"
            status_text = "Accepted" if "Accepted" in raw else "Rejected"
            ssh_logins.append(
                {
                    "ip": source_ip,
                    "target": node_ip,
                    "status": status_text,
                    "date": raw[:32],
                }
            )

    return {"banned_ips": banned_ips[:100], "ssh_logins": ssh_logins[:100]}
