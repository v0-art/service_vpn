import asyncio
import hashlib
import hmac
import json
import logging
import re
import time
from typing import List, Dict, Any, Optional
from urllib.parse import parse_qsl

import asyncssh
from fastapi import APIRouter, Depends, Header, HTTPException, status
from pydantic import BaseModel, Field

from config import config
from db.database import get_db_connection
from services.deployer import deployer
from services.haproxy_manager import haproxy_manager
from services.marzban import marzban_manager
from services.ssh_manager import ssh_manager

logger = logging.getLogger(__name__)

TELEGRAM_INIT_DATA_MAX_AGE_SECONDS = 24 * 60 * 60

ALLOWED_ROLES = {"master", "ingress", "egress"}
ALLOWED_NODE_STATUSES = {"active", "offline"}
ALLOWED_INBOUND_TAGS = {
    "IN-RU-DIRECT",
    "IN-EU-DIRECT",
    "IN-TRANSIT-GB",
    "IN-TRANSIT-NO",
    "IN-EU-TRANSIT-RECV",
    "IN-EU-DIRECT-WARP",
}


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


class NodeCreate(BaseModel):
    name: str = Field(min_length=2, max_length=64)
    ip: str
    role: str
    billing_date: str
    ssh_key: Optional[str] = None
    ssh_port: int = Field(default=config.SSH_PORT, ge=1, le=65535)
    inbound_tag: str
    inbound_port: int = Field(ge=1, le=65535)
    group_sni: str = Field(min_length=2, max_length=255)
    fingerprint: str = Field(min_length=2, max_length=32)
    add_mode: str = "existing"
    # Backward-compatibility with old frontend payload.
    is_new_server: Optional[bool] = None


class NodeUpdate(BaseModel):
    name: Optional[str] = Field(default=None, min_length=2, max_length=64)
    ip: Optional[str] = None
    role: Optional[str] = None
    billing_date: Optional[str] = None
    ssh_key: Optional[str] = None
    ssh_port: Optional[int] = Field(default=None, ge=1, le=65535)
    status: Optional[str] = None
    inbound_tag: Optional[str] = None
    inbound_port: Optional[int] = Field(default=None, ge=1, le=65535)
    group_sni: Optional[str] = Field(default=None, min_length=2, max_length=255)
    fingerprint: Optional[str] = Field(default=None, min_length=2, max_length=32)
    reconnect_marzban: bool = False


class NodeDeleteRequest(BaseModel):
    cleanup_remote: bool = True


class HAProxyUpdate(BaseModel):
    ip: str
    config_content: Optional[str] = None
    # Backward compatibility with current frontend bundle.
    config: Optional[str] = None


class SysinfoRequest(BaseModel):
    ip: str


def _validate_node_role(role: str) -> None:
    if role not in ALLOWED_ROLES:
        raise HTTPException(status_code=400, detail="Некорректная роль ноды.")


def _validate_inbound_tag(tag: str) -> None:
    if tag not in ALLOWED_INBOUND_TAGS:
        raise HTTPException(
            status_code=400,
            detail=f"Некорректная группа inbound: {tag}",
        )


@router.get("/nodes", response_model=List[Dict[str, Any]])
async def get_nodes() -> List[Dict[str, Any]]:
    """Получение списка всех серверов кластера."""
    try:
        async with get_db_connection() as db:
            async with db.execute(
                """
                SELECT
                    id, name, ip, role, billing_date, status,
                    ssh_key, ssh_port,
                    inbound_tag, inbound_port, group_sni, fingerprint,
                    marzban_node_id, marzban_node_status, marzban_last_error,
                    provision_status
                FROM nodes
                ORDER BY id DESC
                """
            ) as cursor:
                rows = await cursor.fetchall()
                result = []
                for row in rows:
                    node_dict = dict(row)
                    node_dict["name"] = node_dict.get("name") or node_dict.get("ip")
                    node_dict["inbound_tag"] = node_dict.get("inbound_tag") or "IN-RU-DIRECT"
                    node_dict["inbound_port"] = int(node_dict.get("inbound_port") or 443)
                    node_dict["group_sni"] = node_dict.get("group_sni") or node_dict.get("ip")
                    node_dict["fingerprint"] = node_dict.get("fingerprint") or "chrome"
                    node_dict["provision_status"] = node_dict.get("provision_status") or "pending"
                    node_dict["marzban_node_status"] = node_dict.get("marzban_node_status") or "unknown"
                    node_dict["has_ssh_key"] = bool(node_dict.get("ssh_key"))
                    node_dict.pop("ssh_key", None)
                    result.append(node_dict)
                return result
    except Exception as exc:
        logger.error("Ошибка при получении нод: %s", exc)
        raise HTTPException(status_code=500, detail="Ошибка базы данных")


@router.post("/nodes")
async def add_node(node: NodeCreate) -> Dict[str, Any]:
    """
    Добавление новой ноды в инвентарь + опциональный bootstrap + привязка к Marzban.
    """
    _validate_node_role(node.role)
    _validate_inbound_tag(node.inbound_tag)

    try:
        mode_raw = (node.add_mode or "").strip().lower()
        if mode_raw not in {"existing", "new"}:
            if node.is_new_server is True:
                mode_raw = "new"
            else:
                mode_raw = "existing"

        final_ssh_key = node.ssh_key
        if not final_ssh_key:
            generated = asyncssh.generate_private_key("ssh-rsa", key_size=2048)
            final_ssh_key = generated.export_private_key().decode("utf-8")

        async with get_db_connection() as db:
            cursor = await db.execute(
                """
                INSERT INTO nodes (
                    name, ip, role, billing_date, status,
                    ssh_key, ssh_port,
                    inbound_tag, inbound_port, group_sni, fingerprint,
                    provision_status
                ) VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    node.name.strip(),
                    node.ip,
                    node.role,
                    node.billing_date,
                    final_ssh_key,
                    node.ssh_port,
                    node.inbound_tag,
                    int(node.inbound_port),
                    node.group_sni.strip(),
                    node.fingerprint.strip(),
                    "provisioning" if mode_raw == "new" else "ready",
                ),
            )
            await db.commit()
            node_id = int(cursor.lastrowid)

        if mode_raw == "existing":
            async with get_db_connection() as db:
                await db.execute(
                    """
                    UPDATE nodes
                    SET marzban_node_status = ?, marzban_last_error = NULL
                    WHERE id = ?
                    """,
                    ("unmanaged", node_id),
                )
                await db.commit()
            return {
                "status": "success",
                "message": (
                    f"Сервер {node.name} добавлен в панель в безопасном режиме "
                    "(без изменений на сервере и в Marzban)."
                ),
                "node_id": node_id,
                "mode": "existing",
            }

        provision_result = await deployer.provision_and_attach(
            node_id=node_id,
            name=node.name.strip(),
            ip=node.ip,
            ssh_port=node.ssh_port,
            inbound_tag=node.inbound_tag,
            inbound_port=node.inbound_port,
            group_sni=node.group_sni.strip(),
            fingerprint=node.fingerprint.strip(),
            is_new_server=True,
        )

        if not provision_result.get("ok"):
            return {
                "status": "partial",
                "message": (
                    f"Сервер {node.name} добавлен в инвентарь, но автоподключение не завершено: "
                    f"{provision_result.get('message', 'неизвестная ошибка')}"
                ),
                "node_id": node_id,
                "provision": provision_result,
                "mode": "new",
            }

        return {
            "status": "success",
            "message": f"Сервер {node.name} успешно добавлен и подключен к Marzban ({node.inbound_tag}).",
            "node_id": node_id,
            "provision": provision_result,
            "mode": "new",
        }
    except HTTPException:
        raise
    except Exception as exc:
        logger.error("Ошибка при добавлении ноды %s: %s", node.ip, exc)
        raise HTTPException(status_code=400, detail="Ошибка при добавлении (возможно IP уже существует).")


@router.put("/nodes/{node_id}")
async def update_node(node_id: int, node: NodeUpdate) -> Dict[str, Any]:
    """
    Редактирование параметров существующей ноды.
    Поддерживает повторную привязку к Marzban (reconnect_marzban=true).
    """
    payload = node.model_dump(exclude_unset=True)
    reconnect_marzban = bool(payload.pop("reconnect_marzban", False))

    if not payload and not reconnect_marzban:
        raise HTTPException(status_code=400, detail="Нет данных для обновления.")

    if "role" in payload:
        _validate_node_role(str(payload["role"]))

    if "status" in payload and payload["status"] not in ALLOWED_NODE_STATUSES:
        raise HTTPException(status_code=400, detail="Некорректный статус ноды.")

    if "inbound_tag" in payload:
        _validate_inbound_tag(str(payload["inbound_tag"]))

    try:
        async with get_db_connection() as db:
            async with db.execute(
                """
                SELECT
                    id, name, ip, role, billing_date, status,
                    ssh_key, ssh_port,
                    inbound_tag, inbound_port, group_sni, fingerprint,
                    marzban_node_id, marzban_node_status, marzban_last_error,
                    provision_status
                FROM nodes WHERE id = ?
                """,
                (node_id,),
            ) as cursor:
                existing = await cursor.fetchone()

            if not existing:
                raise HTTPException(status_code=404, detail="Сервер не найден.")

            merged = dict(existing)
            for key, value in payload.items():
                if key == "ssh_key":
                    if value is None:
                        continue
                    if isinstance(value, str) and not value.strip():
                        continue
                merged[key] = value

            await db.execute(
                """
                UPDATE nodes
                SET name = ?, ip = ?, role = ?, billing_date = ?, status = ?,
                    ssh_key = ?, ssh_port = ?,
                    inbound_tag = ?, inbound_port = ?, group_sni = ?, fingerprint = ?
                WHERE id = ?
                """,
                (
                    merged["name"],
                    merged["ip"],
                    merged["role"],
                    merged["billing_date"],
                    merged["status"],
                    merged["ssh_key"],
                    int(merged["ssh_port"]),
                    merged["inbound_tag"],
                    int(merged["inbound_port"] or 0),
                    merged["group_sni"],
                    merged["fingerprint"],
                    node_id,
                ),
            )
            await db.commit()

        if reconnect_marzban:
            provision_result = await deployer.provision_and_attach(
                node_id=node_id,
                name=str(merged["name"]),
                ip=str(merged["ip"]),
                ssh_port=int(merged["ssh_port"]),
                inbound_tag=str(merged["inbound_tag"]),
                inbound_port=int(merged["inbound_port"]),
                group_sni=str(merged["group_sni"]),
                fingerprint=str(merged["fingerprint"]),
                is_new_server=False,
            )

            if not provision_result.get("ok"):
                return {
                    "status": "partial",
                    "message": (
                        f"Параметры сервера {merged['name']} обновлены, но переподключение к Marzban завершилось ошибкой: "
                        f"{provision_result.get('message')}"
                    ),
                    "provision": provision_result,
                }

            return {
                "status": "success",
                "message": f"Параметры сервера {merged['name']} обновлены и Marzban переподключен.",
                "provision": provision_result,
            }

        return {"status": "success", "message": f"Параметры сервера {merged['name']} обновлены."}
    except HTTPException:
        raise
    except Exception as exc:
        logger.error("Ошибка при обновлении ноды id=%s: %s", node_id, exc)
        raise HTTPException(status_code=400, detail="Не удалось обновить сервер (проверьте уникальность IP).")


@router.delete("/nodes/{node_id}")
async def delete_node(node_id: int, payload: NodeDeleteRequest) -> Dict[str, Any]:
    """
    Удаление ноды из панели, Marzban и (опционально) cleanup на самой ноде по SSH.
    """
    try:
        async with get_db_connection() as db:
            async with db.execute(
                """
                SELECT id, name, ip, inbound_tag, marzban_node_id
                FROM nodes
                WHERE id = ?
                """,
                (node_id,),
            ) as cursor:
                row = await cursor.fetchone()

        if not row:
            raise HTTPException(status_code=404, detail="Сервер не найден.")

        node = dict(row)
        result = await deployer.delete_from_everywhere(
            node_id=int(node["id"]),
            name=str(node.get("name") or node["ip"]),
            ip=str(node["ip"]),
            inbound_tag=node.get("inbound_tag"),
            marzban_node_id=node.get("marzban_node_id"),
            cleanup_on_node=payload.cleanup_remote,
        )

        return result
    except HTTPException:
        raise
    except Exception as exc:
        logger.error("Ошибка удаления ноды id=%s: %s", node_id, exc)
        raise HTTPException(status_code=400, detail="Не удалось удалить сервер.")


@router.get("/status/overview")
async def get_status_overview() -> Dict[str, Any]:
    """
    Сводный статус панели:
    - доступность Marzban
    - фактическая SSH-связность с нодами
    """
    async with get_db_connection() as db:
        async with db.execute(
            """
            SELECT
                id, name, ip, role, status, ssh_port,
                inbound_tag, provision_status, marzban_node_status, marzban_last_error
            FROM nodes
            ORDER BY id ASC
            """
        ) as cursor:
            nodes_rows = await cursor.fetchall()

    nodes = [dict(row) for row in nodes_rows]
    nodes_total = len(nodes)
    nodes_active = len([node for node in nodes if node.get("status") == "active"])

    marzban_status = await marzban_manager.get_connection_status()

    semaphore = asyncio.Semaphore(5)

    async def check_node_connection(node: Dict[str, Any]) -> Dict[str, Any]:
        node_ip = str(node.get("ip", ""))
        node_status = str(node.get("status", "offline"))
        node_port = int(node.get("ssh_port") or config.SSH_PORT)

        if node_status != "active":
            return {
                "id": node.get("id"),
                "name": node.get("name"),
                "ip": node_ip,
                "role": node.get("role"),
                "status": node_status,
                "ssh_port": node_port,
                "inbound_tag": node.get("inbound_tag"),
                "provision_status": node.get("provision_status"),
                "marzban_node_status": node.get("marzban_node_status"),
                "marzban_last_error": node.get("marzban_last_error"),
                "checked": False,
                "connected": False,
                "error": "Сервер помечен как неактивный.",
            }

        async with semaphore:
            success, output = await ssh_manager.execute_command(
                node_ip,
                "echo LUFFY_OK",
                timeout=8,
            )

        return {
            "id": node.get("id"),
            "name": node.get("name"),
            "ip": node_ip,
            "role": node.get("role"),
            "status": node_status,
            "ssh_port": node_port,
            "inbound_tag": node.get("inbound_tag"),
            "provision_status": node.get("provision_status"),
            "marzban_node_status": node.get("marzban_node_status"),
            "marzban_last_error": node.get("marzban_last_error"),
            "checked": True,
            "connected": bool(success and "LUFFY_OK" in output),
            "error": None if success else output,
        }

    checked_nodes = await asyncio.gather(*(check_node_connection(node) for node in nodes))
    checked_active_nodes = [node for node in checked_nodes if node["checked"]]
    ssh_reachable = len([node for node in checked_active_nodes if node["connected"]])
    ssh_unreachable = len(checked_active_nodes) - ssh_reachable

    return {
        "timestamp": int(time.time()),
        "nodes_total": nodes_total,
        "nodes_active": nodes_active,
        "ssh_reachable": ssh_reachable,
        "ssh_unreachable": ssh_unreachable,
        "marzban_connected": bool(marzban_status.get("connected")),
        "marzban_users_count": int(marzban_status.get("users_count", 0)),
        "marzban_error": marzban_status.get("error"),
        "marzban_error_code": marzban_status.get("error_code"),
        "marzban_http_status": marzban_status.get("http_status"),
        "nodes": checked_nodes,
    }


@router.get("/marzban/connection")
async def get_marzban_connection() -> Dict[str, Any]:
    """
    Явная проверка коннекта к Marzban для UI.
    """
    return await marzban_manager.get_connection_status(force_reauth=True)


@router.post("/marzban/reconnect")
async def reconnect_marzban() -> Dict[str, Any]:
    """
    Принудительное переподключение к Marzban (сброс токена).
    """
    result = await marzban_manager.force_reconnect()
    if result.get("connected"):
        return {
            "status": "success",
            "message": "Подключение к Marzban восстановлено.",
            "connection": result,
        }

    return {
        "status": "error",
        "message": result.get("error") or "Не удалось восстановить подключение к Marzban.",
        "connection": result,
    }


@router.post("/haproxy/apply")
async def apply_haproxy_config(data: HAProxyUpdate) -> Dict[str, str]:
    """
    Применение нового конфига HAProxy на указанной ноде.
    Использует HAProxyManager для безопасного деплоя с откатом.
    """
    logger.info("Запрос на обновление HAProxy для %s", data.ip)

    config_content = (data.config_content or data.config or "").strip()
    if not config_content:
        raise HTTPException(
            status_code=400,
            detail="Пустая конфигурация: передайте 'config_content' (или 'config' для совместимости).",
        )

    success, message = await haproxy_manager.apply_config(data.ip, config_content)

    if success:
        return {"status": "success", "message": message}

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
    - anomalies
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
        status_value = str(user.get("status", "unknown"))
        used_gb = round(used_traffic / (1024**3), 2)

        top_users.append(
            {
                "username": username,
                "traffic": f"{used_gb} GB",
                "status": status_value,
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
