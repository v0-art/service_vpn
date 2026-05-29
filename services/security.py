import logging
import hashlib
import re
from collections import defaultdict
from aiogram import Bot
from config import config
from db.database import get_db_connection
from services.ssh_manager import ssh_manager
from bot.notifier import send_alert

logger = logging.getLogger(__name__)
SSH_AUDIT_SEEN_EVENTS: set[str] = set()
SSH_AUDIT_SEEN_LIMIT = 1000
SOURCE_IP_RE = re.compile(r"\bfrom (\d{1,3}(?:\.\d{1,3}){3})\b")


def _configured_trusted_ssh_ips() -> set[str]:
    raw_value = config.SSH_AUDIT_TRUSTED_IPS or ""
    return {item.strip() for item in re.split(r"[,;\s]+", raw_value) if item.strip()}


def _extract_source_ip(log_line: str) -> str | None:
    match = SOURCE_IP_RE.search(log_line)
    return match.group(1) if match else None


def _remember_ssh_event(log_line: str) -> bool:
    fingerprint = hashlib.sha256(log_line.encode("utf-8", errors="ignore")).hexdigest()
    if fingerprint in SSH_AUDIT_SEEN_EVENTS:
        return False

    SSH_AUDIT_SEEN_EVENTS.add(fingerprint)
    if len(SSH_AUDIT_SEEN_EVENTS) > SSH_AUDIT_SEEN_LIMIT:
        SSH_AUDIT_SEEN_EVENTS.clear()
    return True

async def auto_ban_scanners(bot: Bot) -> None:
    """
    Парсит /var/log/nginx/access.log на Ingress нодах.
    Если IP стучится в Decoy > 20 раз, добавляет правило ufw insert 1 deny from <IP>.
    """
    logger.info("Запуск Auto-Ban сканеров...")
    async with get_db_connection() as db:
        async with db.execute("SELECT ip FROM nodes WHERE role = 'ingress' AND status = 'active'") as cursor:
            nodes = await cursor.fetchall()

    for node in nodes:
        node_ip = node['ip']
        # Читаем последние 500 строк лога nginx, ищем попытки доступа к Decoy
        cmd = "tail -n 500 /var/log/nginx/access.log | awk '{print $1}'"
        success, result = await ssh_manager.execute_command(node_ip, cmd, timeout=15)
        
        if success and result:
            ip_counts = defaultdict(int)
            for line in result.strip().split('\n'):
                ip = line.strip()
                if ip:
                    ip_counts[ip] += 1
            
            banned_count = 0
            for ip, count in ip_counts.items():
                if count > 20:
                    # Баним IP через UFW
                    ban_cmd = f"ufw insert 1 deny from {ip} to any"
                    ban_success, _ = await ssh_manager.execute_command(node_ip, ban_cmd, timeout=10)
                    if ban_success:
                        banned_count += 1
                        logger.info(f"Забанен IP {ip} на Ingress-ноде {node_ip} (запросов: {count})")
            
            if banned_count > 0:
                await send_alert(bot, f"🛡 <b>Auto-Ban активирован!</b>\nНа ноде <code>{node_ip}</code> заблокировано сканеров: <b>{banned_count}</b>.")


async def ssh_audit(bot: Bot) -> None:
    """
    Ищет неожиданные успешные SSH-входы.

    Рутинные подключения с master/admin источников не являются аварией, поэтому
    фильтруются по роли master и SSH_AUDIT_TRUSTED_IPS.
    """
    logger.info("Запуск SSH Audit...")
    async with get_db_connection() as db:
        async with db.execute("SELECT ip, role FROM nodes WHERE status = 'active'") as cursor:
            nodes = await cursor.fetchall()
        async with db.execute(
            """
            SELECT DISTINCT n.ip
            FROM nodes n
            JOIN node_roles nr ON nr.node_id = n.id
            WHERE nr.role = 'master' AND n.status = 'active'
            """
        ) as cursor:
            master_role_rows = await cursor.fetchall()

    trusted_source_ips = _configured_trusted_ssh_ips()
    trusted_source_ips.update(str(row["ip"]) for row in nodes if row["role"] == "master")
    trusted_source_ips.update(str(row["ip"]) for row in master_role_rows)

    for node in nodes:
        node_ip = node['ip']
        node_role = node['role']
        # $SSH_CONNECTION показывает source IP текущего служебного подключения
        # Control Tower к ноде; такие входы не должны считаться инцидентом.
        cmd = (
            'printf "__LUFFY_AUDIT_SOURCE__ %s\\n" "$SSH_CONNECTION"; '
            'journalctl -u ssh -u sshd --since "16 minutes ago" --no-pager | grep "Accepted" || true'
        )
        success, result = await ssh_manager.execute_command(node_ip, cmd, timeout=10)
        
        if success and result.strip():
            node_trusted_source_ips = set(trusted_source_ips)
            logins = []
            for raw_login in result.strip().split('\n'):
                login = raw_login.strip()
                if not login:
                    continue

                if login.startswith("__LUFFY_AUDIT_SOURCE__"):
                    parts = login.split()
                    if len(parts) >= 2:
                        node_trusted_source_ips.add(parts[1])
                    continue

                source_ip = _extract_source_ip(login)
                if source_ip and source_ip in node_trusted_source_ips:
                    logger.debug("SSH Audit: пропущен trusted login from %s на %s", source_ip, node_ip)
                    continue

                if not _remember_ssh_event(f"{node_ip}|{login}"):
                    continue

                logins.append(login)

            if not logins:
                continue

            alert_msg = f"🔐 <b>Успешный SSH Вход!</b>\nНода: <code>{node_ip}</code> ({node_role})\nСобытия:\n"
            for login in logins:
                alert_msg += f"- <code>{login.strip()}</code>\n"
            
            await send_alert(bot, alert_msg)
