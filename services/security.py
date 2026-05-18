import logging
import re
from datetime import datetime
from collections import defaultdict
from aiogram import Bot
from db.database import get_db_connection
from services.ssh_manager import ssh_manager
from bot.notifier import send_alert

logger = logging.getLogger(__name__)

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
    Ищет "Accepted" в journalctl -u ssh за последние 15 минут.
    Отправляет алерт при успешном входе.
    """
    logger.info("Запуск SSH Audit...")
    async with get_db_connection() as db:
        async with db.execute("SELECT ip, role FROM nodes WHERE status = 'active'") as cursor:
            nodes = await cursor.fetchall()

    for node in nodes:
        node_ip = node['ip']
        node_role = node['role']
        # journalctl с фильтром по времени (последние 15 минут)
        cmd = 'journalctl -u ssh --since "15 minutes ago" | grep "Accepted"'
        success, result = await ssh_manager.execute_command(node_ip, cmd, timeout=10)
        
        if success and result.strip():
            # Нашли успешные логины
            logins = result.strip().split('\n')
            alert_msg = f"🔐 <b>Успешный SSH Вход!</b>\nНода: <code>{node_ip}</code> ({node_role})\nСобытия:\n"
            for login in logins:
                alert_msg += f"- <code>{login.strip()}</code>\n"
            
            await send_alert(bot, alert_msg)
