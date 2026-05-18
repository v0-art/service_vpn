import logging
from fastapi import APIRouter, HTTPException, Body
from pydantic import BaseModel
from typing import List, Dict, Any, Optional

from db.database import get_db_connection
from services.haproxy_manager import haproxy_manager

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api", tags=["MiniApp API"])

# --- Pydantic Модели ---
class NodeCreate(BaseModel):
    ip: str
    role: str
    billing_date: str
    ssh_key: Optional[str] = None

class HAProxyUpdate(BaseModel):
    ip: str
    config_content: str

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
    
    success, message = await haproxy_manager.apply_config(data.ip, data.config_content)
    
    if success:
        return {"status": "success", "message": message}
    else:
        # Возвращаем 400 с текстом ошибки (например, синтаксической), чтобы показать в UI
        raise HTTPException(status_code=400, detail=message)