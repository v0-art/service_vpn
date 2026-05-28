import logging
import asyncssh
from typing import Tuple, Dict, Any, Optional, List

from config import config
from db.database import get_db_connection
from services.ssh_manager import ssh_manager
from services.marzban import marzban_manager
from services.secrets import secret_manager

logger = logging.getLogger(__name__)


class NodeDeployer:
    """
    Сервис оркестрации нод:
    - legacy deploy по паролю (для совместимости)
    - bootstrap новой ноды (утилиты, docker, marzban-node)
    - регистрация ноды в Marzban и привязка к inbound group
    - cleanup при удалении
    """

    def __init__(self) -> None:
        self.pub_key_path = f"{config.SSH_KEY_PATH}.pub"

    async def _inject_ssh_key(self, ip: str, password: str, public_key_str: str) -> Tuple[bool, str]:
        setup_script = f"""
        set -e
        mkdir -p ~/.ssh
        chmod 700 ~/.ssh
        grep -qxF '{public_key_str}' ~/.ssh/authorized_keys || echo '{public_key_str}' >> ~/.ssh/authorized_keys
        chmod 600 ~/.ssh/authorized_keys
        """

        try:
            async with asyncssh.connect(
                ip,
                port=config.SSH_PORT,
                username=config.SSH_DEFAULT_USER,
                password=password,
                known_hosts=None,
            ) as conn:
                result = await conn.run(setup_script, check=False)
                if result.exit_status == 0:
                    return True, "SSH ключ успешно установлен."
                return False, f"Ошибка установки ключа: {result.stderr}"
        except Exception as exc:
            logger.error("Ошибка инъекции ключа на %s: %s", ip, exc)
            return False, str(exc)

    async def deploy_node(self, ip: str, role: str, password: str, billing_date: str) -> Tuple[bool, str]:
        """
        Legacy-команда /deploy из бота.
        Оставлена для обратной совместимости.
        """
        logger.info("Legacy deploy запрошен для %s (%s)", ip, role)

        try:
            generated_key = asyncssh.generate_private_key("ssh-rsa", key_size=2048)
            private_key_str = generated_key.export_private_key().decode("utf-8")
            public_key_str = generated_key.export_public_key().decode("utf-8").strip()
        except Exception as exc:
            return False, f"Ошибка генерации SSH-ключа: {exc}"

        key_success, key_msg = await self._inject_ssh_key(ip, password, public_key_str)
        if not key_success:
            return False, f"Сбой на этапе авторизации: {key_msg}"

        try:
            async with get_db_connection() as db:
                await db.execute("DELETE FROM nodes WHERE ip = ?", (ip,))
                await db.execute(
                    """
                    INSERT INTO nodes (
                        name, ip, role, billing_date, status,
                        ssh_key, ssh_username, ssh_port, credential_status,
                        provision_status
                    ) VALUES (?, ?, ?, ?, 'active', ?, ?, ?, 'configured', 'pending')
                    """,
                    (
                        ip,
                        ip,
                        role,
                        billing_date,
                        secret_manager.encrypt(private_key_str),
                        config.SSH_DEFAULT_USER,
                        config.SSH_PORT,
                    ),
                )
                await db.commit()
        except Exception as exc:
            logger.error("Ошибка предварительного сохранения ноды %s: %s", ip, exc)
            return False, "Не удалось сохранить SSH-ключ в базу данных."

        # Для legacy делаем только базовый bootstrap
        install_result = await self.bootstrap_new_server(ip)
        if not install_result["ok"]:
            return False, install_result["message"]

        return True, f"Нода {ip} ({role}) успешно подготовлена и добавлена в кластер."

    async def bootstrap_new_server(self, ip: str) -> Dict[str, Any]:
        """
        Устанавливает базовый набор ПО на новую ноду:
        ufw, fail2ban, docker, marzban-node + инструменты мониторинга.
        """
        bootstrap_script = r"""
set -e
export DEBIAN_FRONTEND=noninteractive

apt-get update -y
apt-get install -y \
  ca-certificates \
  curl \
  gnupg \
  lsb-release \
  software-properties-common \
  jq \
  unzip \
  ufw \
  fail2ban \
  htop \
  net-tools \
  iotop \
  vnstat

# Docker (если не установлен)
if ! command -v docker >/dev/null 2>&1; then
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  echo \
    "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian \
    $(. /etc/os-release && echo $VERSION_CODENAME) stable" | tee /etc/apt/sources.list.d/docker.list > /dev/null
  apt-get update -y
  apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
fi

systemctl enable docker || true
systemctl start docker || true

systemctl enable fail2ban || true
systemctl restart fail2ban || true

ufw --force enable || true
ufw allow 22/tcp || true

# marzban-node installer (идемпотентно, если уже есть - пропускаем)
if [ ! -f /opt/marzban-node/docker-compose.yml ]; then
  bash -c "$(curl -fsSL https://github.com/Gozargah/Marzban-scripts/raw/master/marzban-node.sh)" @ install || true
fi

echo "LUFFY_BOOTSTRAP_OK"
"""

        success, output = await ssh_manager.execute_command(ip, bootstrap_script, timeout=1200)
        if not success:
            return {
                "ok": False,
                "message": f"Bootstrap ноды {ip} не завершен: {output}",
                "output": output,
            }

        return {
            "ok": True,
            "message": f"Нода {ip} подготовлена: утилиты и marzban-node установлены.",
            "output": output,
        }

    async def provision_and_attach(
        self,
        *,
        node_id: int,
        name: str,
        ip: str,
        ssh_port: int,
        inbound_tag: str,
        inbound_port: int,
        group_sni: str,
        fingerprint: str,
        is_new_server: bool,
    ) -> Dict[str, Any]:
        """
        Полный pipeline для ноды:
        1) bootstrap новой ноды (опционально)
        2) add node в Marzban
        3) attach host в inbound group
        """
        steps: List[Dict[str, Any]] = []

        if is_new_server:
            bootstrap = await self.bootstrap_new_server(ip)
            steps.append({"step": "bootstrap", **bootstrap})
            if not bootstrap["ok"]:
                await self._set_node_provision_state(node_id, "error", "Ошибка bootstrap новой ноды")
                return {"ok": False, "steps": steps, "message": bootstrap["message"]}

        marzban_add = await marzban_manager.add_node(name=name, address=ip, port=ssh_port)
        steps.append({"step": "marzban_add_node", **marzban_add})
        if not marzban_add.get("ok"):
            await self._set_node_provision_state(node_id, "error", marzban_add.get("error"))
            return {"ok": False, "steps": steps, "message": marzban_add.get("error")}

        marzban_node_id = marzban_add.get("node_id")

        attach_result = await marzban_manager.ensure_host_in_group(
            inbound_tag=inbound_tag,
            remark=name,
            address=ip,
            port=inbound_port,
            sni=group_sni,
            fingerprint=fingerprint,
        )
        steps.append({"step": "marzban_attach_inbound", **attach_result})

        if not attach_result.get("ok"):
            await self._set_node_provision_state(node_id, "error", attach_result.get("error"))
            return {"ok": False, "steps": steps, "message": attach_result.get("error")}

        async with get_db_connection() as db:
            await db.execute(
                """
                UPDATE nodes
                SET marzban_node_id = ?,
                    marzban_node_status = ?,
                    marzban_last_error = NULL,
                    provision_status = ?
                WHERE id = ?
                """,
                (marzban_node_id, "connected", "ready", node_id),
            )
            await db.commit()

        return {
            "ok": True,
            "steps": steps,
            "message": f"Сервер {name} подключен: Marzban + inbound {inbound_tag} настроены.",
            "marzban_node_id": marzban_node_id,
        }

    async def delete_from_everywhere(
        self,
        *,
        node_id: int,
        name: str,
        ip: str,
        inbound_tag: Optional[str],
        marzban_node_id: Optional[int],
        cleanup_on_node: bool,
        inbounds: Optional[List[Dict[str, Any]]] = None,
    ) -> Dict[str, Any]:
        """
        Удаление ноды:
        - из Marzban hosts/inbound
        - из Marzban node registry
        - (опционально) cleanup на удаленной ноде по SSH
        """
        steps: List[Dict[str, Any]] = []

        if inbounds:
            for inbound in inbounds:
                host_remove = await marzban_manager.remove_host_from_group(
                    inbound_tag=str(inbound.get("inbound_tag")),
                    address=str(inbound.get("address") or ip),
                    remark=str(inbound.get("remark") or name),
                )
                steps.append({"step": "marzban_remove_host", **host_remove})
        elif inbound_tag:
            host_remove = await marzban_manager.remove_host_from_group(
                inbound_tag=inbound_tag,
                address=ip,
                remark=name,
            )
            steps.append({"step": "marzban_remove_host", **host_remove})

        if marzban_node_id:
            node_remove = await marzban_manager.remove_node(int(marzban_node_id))
            steps.append({"step": "marzban_remove_node", **node_remove})

        if cleanup_on_node:
            cleanup_script = r"""
set +e
systemctl stop marzban-node 2>/dev/null || true
cd /opt/marzban-node 2>/dev/null && docker compose down 2>/dev/null || true
rm -rf /opt/marzban-node 2>/dev/null || true
ufw delete allow 22/tcp 2>/dev/null || true
echo "LUFFY_REMOTE_CLEANUP_OK"
"""
            success, output = await ssh_manager.execute_command(ip, cleanup_script, timeout=300)
            steps.append(
                {
                    "step": "remote_cleanup",
                    "ok": success,
                    "message": output if success else f"Ошибка cleanup на ноде: {output}",
                }
            )

        async with get_db_connection() as db:
            await db.execute("DELETE FROM nodes WHERE id = ?", (node_id,))
            await db.commit()

        return {
            "ok": True,
            "message": f"Сервер {name} удален из панели и Marzban.",
            "steps": steps,
        }

    async def _set_node_provision_state(self, node_id: int, state: str, error_text: Optional[str]) -> None:
        async with get_db_connection() as db:
            await db.execute(
                """
                UPDATE nodes
                SET provision_status = ?,
                    marzban_last_error = ?,
                    marzban_node_status = CASE WHEN ? = 'error' THEN 'error' ELSE marzban_node_status END
                WHERE id = ?
                """,
                (state, error_text, state, node_id),
            )
            await db.commit()


# Глобальный экземпляр
deployer = NodeDeployer()
