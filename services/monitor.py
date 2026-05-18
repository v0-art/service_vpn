import logging
from datetime import datetime, timedelta
from apscheduler.schedulers.asyncio import AsyncIOScheduler
from aiogram import Bot
from services.marzban import marzban_manager
from db.database import get_db_connection
from services.ssh_manager import ssh_manager
from bot.notifier import send_alert
from services.security import auto_ban_scanners, ssh_audit
from services.backup import backup_database

logger = logging.getLogger(__name__)
scheduler = AsyncIOScheduler()

async def check_disk_space(bot: Bot) -> None:
    """
    Проверяет свободное место на всех нодах.
    Если занято > 85%, отправляет алерт.
    """
    logger.info("Запуск проверки дискового пространства...")
    
    async with get_db_connection() as db:
        async with db.execute("SELECT ip, role FROM nodes WHERE status = 'active'") as cursor:
            nodes = await cursor.fetchall()

    for node in nodes:
        ip = node['ip']
        # Команда выводит процент занятого места на корневом разделе (например, "45")
        cmd = "df -h / | awk 'NR==2 {print $5}' | sed 's/%//'"
        success, result = await ssh_manager.execute_command(ip, cmd, timeout=10)
        
        if success and result.isdigit():
            usage = int(result)
            if usage > 85:
                await send_alert(bot, f"💾 <b>Критическое заполнение диска!</b>\nНода: <code>{ip}</code> ({node['role']})\nЗанято: <b>{usage}%</b>")
        else:
            logger.warning(f"Не удалось проверить диск на {ip}: {result}")

async def check_billing(bot: Bot) -> None:
    """
    Проверяет даты оплаты серверов.
    Если до конца аренды осталось <= 3 дней, отправляет напоминание.
    """
    logger.info("Запуск проверки биллинга...")
    today = datetime.now().date()
    warning_date = today + timedelta(days=3)

    async with get_db_connection() as db:
        async with db.execute("SELECT ip, role, billing_date FROM nodes WHERE status = 'active'") as cursor:
            nodes = await cursor.fetchall()

    for node in nodes:
        try:
            # Ожидаемый формат даты в БД: YYYY-MM-DD
            billing_date = datetime.strptime(node['billing_date'], "%Y-%m-%d").date()
            
            if billing_date <= warning_date and billing_date >= today:
                days_left = (billing_date - today).days
                await send_alert(bot, f"💳 <b>Напоминание об оплате!</b>\nНода: <code>{node['ip']}</code> ({node['role']})\nОсталось дней: <b>{days_left}</b> (до {billing_date})")
            elif billing_date < today:
                await send_alert(bot, f"💀 <b>СЕРВЕР ПРОСРОЧЕН!</b>\nНода: <code>{node['ip']}</code> ({node['role']})\nДата оплаты: {billing_date}")
        except ValueError:
            logger.error(f"Неверный формат даты биллинга для {node['ip']}: {node['billing_date']}")

async def external_port_knocker(bot: Bot) -> None:
    """
    Master-нода проверяет доступность портов 443 и 2096 на Ingress-нодах.
    Это гарантирует, что трафик реально доходит до Ingress.
    """
    logger.info("Запуск External Port Knocker...")
    
    async with get_db_connection() as db:
        # Ищем Master-ноду
        async with db.execute("SELECT ip FROM nodes WHERE role = 'master' AND status = 'active' LIMIT 1") as cursor:
            master_row = await cursor.fetchone()
        
        # Ищем Ingress-ноды (все, чтобы проверять и упавшие)
        async with db.execute("SELECT ip, status FROM nodes WHERE role = 'ingress'") as cursor:
            ingress_nodes = await cursor.fetchall()

    if not master_row or not ingress_nodes:
        logger.warning("Port Knocker отменен: нет Master или Ingress нод в БД.")
        return

    master_ip = master_row['ip']

    for ingress in ingress_nodes:
        ingress_ip = ingress['ip']
        ingress_status = ingress['status']
        # Используем nc (netcat) с Master-ноды для проверки портов Ingress-ноды
        cmd = f"nc -z -w 3 {ingress_ip} 443 && nc -z -w 3 {ingress_ip} 2096 && echo 'OK' || echo 'FAIL'"
        
        success, result = await ssh_manager.execute_command(master_ip, cmd, timeout=15)
        
        is_alive = success and "FAIL" not in result
        
        if is_alive and ingress_status == 'offline':
            # Нода ожила, возвращаем в балансировщик
            recover_cmd = f"sed -i '/{ingress_ip}/s/^#*//' /etc/haproxy/haproxy.cfg && systemctl reload haproxy"
            await ssh_manager.execute_command(master_ip, recover_cmd, timeout=10)
            
            async with get_db_connection() as db:
                await db.execute("UPDATE nodes SET status = 'active' WHERE ip = ?", (ingress_ip,))
                await db.commit()
                
            await send_alert(bot, f"🟢 <b>Auto-Recover!</b>\nIngress-нода <code>{ingress_ip}</code> снова доступна.\nАвтоматически возвращена в HAProxy.")
            
        elif not is_alive and ingress_status == 'active':
            # Нода упала, убираем из балансировщика
            failover_cmd = f"sed -i '/{ingress_ip}/s/^/#/' /etc/haproxy/haproxy.cfg && systemctl reload haproxy"
            await ssh_manager.execute_command(master_ip, failover_cmd, timeout=10)
            
            async with get_db_connection() as db:
                await db.execute("UPDATE nodes SET status = 'offline' WHERE ip = ?", (ingress_ip,))
                await db.commit()
                
            await send_alert(bot, f"🔴 <b>Auto-Failover! / Узел недоступен!</b>\nMaster не может достучаться до Ingress (<code>{ingress_ip}</code>).\nНода временно <b>отключена</b> из конфига HAProxy для защиты трафика.")

async def check_decoy_watchdog(bot: Bot) -> None:
    """Проверяет, отдает ли Nginx Decoy HTTP 200."""
    logger.info("Запуск Decoy Watchdog...")
    async with get_db_connection() as db:
        async with db.execute("SELECT ip FROM nodes WHERE role = 'ingress' AND status = 'active'") as cursor:
            nodes = await cursor.fetchall()
            
    for node in nodes:
        cmd = f'curl -s -o /dev/null -w "%{{http_code}}" http://{node["ip"]}:8449'
        success, result = await ssh_manager.execute_command(node["ip"], cmd, timeout=10)
        if success and result.strip() != "200":
            await send_alert(bot, f"⚠️ <b>Decoy Watchdog Alert!</b>\nNginx на {node['ip']} вернул код {result.strip()} вместо 200.")

async def check_ssl_expiry(bot: Bot) -> None:
    """Проверяет срок действия SSL на Ingress нодах (порт 443)."""
    logger.info("Запуск SSL Expiry Check...")
    async with get_db_connection() as db:
        async with db.execute("SELECT ip FROM nodes WHERE role = 'ingress' AND status = 'active'") as cursor:
            nodes = await cursor.fetchall()
            
    for node in nodes:
        cmd = f"echo | openssl s_client -connect {node['ip']}:443 2>/dev/null | openssl x509 -noout -enddate | cut -d= -f2"
        success, result = await ssh_manager.execute_command(node["ip"], cmd, timeout=10)
        if success and result:
            try:
                # Example: "Jun 16 12:00:00 2024 GMT" -> %b %d %H:%M:%S %Y %Z
                expiry_date = datetime.strptime(result.strip(), "%b %d %H:%M:%S %Y %Z")
                days_left = (expiry_date - datetime.now()).days
                if days_left < 10:
                    await send_alert(bot, f"🔐 <b>SSL Сертификат истекает!</b>\nНода: {node['ip']}\nОсталось дней: {days_left}")
            except Exception as e:
                logger.error(f"Ошибка парсинга даты SSL: {e}")

async def check_link_latency(bot: Bot) -> None:
    """Измеряет пинг между Ingress (Москва) и Egress (Европа)."""
    logger.info("Запуск Link Latency Check...")
    async with get_db_connection() as db:
        async with db.execute("SELECT ip FROM nodes WHERE role = 'ingress' AND status = 'active'") as cursor:
            ingress_nodes = await cursor.fetchall()
        async with db.execute("SELECT ip FROM nodes WHERE role = 'egress' AND status = 'active'") as cursor:
            egress_nodes = await cursor.fetchall()
            
    if not ingress_nodes or not egress_nodes:
        return
        
    for ingress in ingress_nodes:
        for egress in egress_nodes:
            cmd = f"ping -c 5 {egress['ip']} | tail -1 | awk '{{print $4}}' | cut -d '/' -f 2"
            success, result = await ssh_manager.execute_command(ingress['ip'], cmd, timeout=15)
            if success and result.strip():
                try:
                    latency = float(result.strip())
                    if latency > 150:
                        await send_alert(bot, f"📉 <b>Деградация канала!</b>\nПинг между Ingress ({ingress['ip']}) и Egress ({egress['ip']}) составляет <b>{latency}ms</b> (норма < 150ms).")
                except ValueError:
                    logger.error(f"Не удалось распарсить результат ping: {result}")

def setup_scheduler(bot: Bot) -> None:
    """
    Регистрация и запуск фоновых задач.
    """
    # Проверка диска каждые 6 часов
    scheduler.add_job(check_disk_space, 'interval', hours=6, args=[bot])
    
    # Проверка портов каждые 15 минут
    scheduler.add_job(external_port_knocker, 'interval', minutes=15, args=[bot])
    
    # Проверка биллинга каждый день в 10:00 утра
    scheduler.add_job(check_billing, 'cron', hour=10, minute=0, args=[bot])
    scheduler.add_job(marzban_manager.check_traffic_anomalies, 'interval', hours=1, args=[bot])

    # Добавленные проверки из ТЗ
    scheduler.add_job(check_decoy_watchdog, 'interval', minutes=5, args=[bot])
    scheduler.add_job(check_ssl_expiry, 'cron', hour=9, minute=0, args=[bot])
    scheduler.add_job(check_link_latency, 'interval', minutes=30, args=[bot])
    
    # Модуль Security & Backup
    scheduler.add_job(auto_ban_scanners, 'interval', minutes=15, args=[bot])
    scheduler.add_job(ssh_audit, 'interval', minutes=15, args=[bot])
    scheduler.add_job(backup_database, 'cron', day_of_week='sun', hour=3, minute=0, args=[bot])
    
    scheduler.start()
    logger.info("APScheduler успешно запущен. Фоновые задачи активированы.")

def shutdown_scheduler() -> None:
    """Останавливает планировщик фоновых задач."""
    if scheduler.running:
        scheduler.shutdown(wait=True)
        logger.info("APScheduler корректно остановлен.")