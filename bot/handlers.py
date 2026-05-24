import logging
from urllib.parse import urlencode
from aiogram import Router, types
from aiogram.filters import CommandStart, Command

from config import config
from db.database import get_db_connection
from services.ssh_manager import ssh_manager

logger = logging.getLogger(__name__)
router = Router()

def is_admin(user_id: int) -> bool:
    """Проверка прав доступа."""
    return user_id == config.ADMIN_ID

from aiogram.types import ReplyKeyboardMarkup, KeyboardButton, WebAppInfo

@router.message(CommandStart())
async def cmd_start(message: types.Message) -> None:
    if not message.from_user or not is_admin(message.from_user.id):
        return

    web_app_url = config.WEB_APP_URL.strip()
    if not web_app_url:
        await message.answer(
            "⚠️ Mini App не настроен: в `.env` отсутствует `WEB_APP_URL`.\n"
            "Пример: <code>WEB_APP_URL=https://your-domain.example</code>",
            parse_mode="HTML",
        )
        return

    if not web_app_url.startswith("https://"):
        await message.answer(
            "⚠️ `WEB_APP_URL` должен начинаться с `https://`.\n"
            "Telegram Web App не открывается по `http://`.",
            parse_mode="HTML",
        )
        return

    # Cache-buster для Telegram WebApp: позволяет принудительно обновлять фронтенд
    # без смены домена (задаем WEB_APP_VERSION в .env)
    web_app_version = config.WEB_APP_VERSION.strip()
    if web_app_version:
        sep = "&" if "?" in web_app_url else "?"
        web_app_url = f"{web_app_url}{sep}{urlencode({'v': web_app_version})}"
    
    markup = ReplyKeyboardMarkup(
        keyboard=[[KeyboardButton(text="🎛 Открыть Control Tower", web_app=WebAppInfo(url=web_app_url))]],
        resize_keyboard=True
    )
    
    text = "🏴‍☠️ <b>LUFFY Control Tower v2.6</b>\n\nНажмите кнопку ниже для открытия панели управления."
    await message.answer(text, reply_markup=markup, parse_mode="HTML")

@router.message(Command("nodes"))
async def cmd_nodes(message: types.Message) -> None:
    if not message.from_user or not is_admin(message.from_user.id):
        return

    async with get_db_connection() as db:
        async with db.execute("SELECT ip, role, billing_date, status FROM nodes") as cursor:
            nodes = await cursor.fetchall()

    if not nodes:
        await message.answer("⚠️ Инвентарь пуст. Добавьте ноды через Mini App.")
        return

    text = "🖥 <b>LUFFY Cluster Nodes:</b>\n\n"
    for node in nodes:
        text += (
            f"🔹 <b>{node['ip']}</b> [<code>{node['role']}</code>]\n"
            f"   Оплата: {node['billing_date']} | Статус: {node['status']}\n\n"
        )
    
    await message.answer(text, parse_mode="HTML")

@router.message(Command("sysinfo"))
async def cmd_sysinfo(message: types.Message) -> None:
    """Выполняет базовую диагностику (uptime, RAM, Disk) на указанной ноде."""
    if not message.from_user or not is_admin(message.from_user.id):
        return

    if not message.text:
        return
    args = message.text.split()
    if len(args) < 2:
        await message.answer("⚠️ Использование: <code>/sysinfo &lt;ip&gt;</code>", parse_mode="HTML")
        return

    target_ip = args[1]
    await message.answer(f"⏳ Собираю метрики с <b>{target_ip}</b>...", parse_mode="HTML")

    # Комбинируем команды для одного SSH-подключения
    command = "echo '--- UPTIME ---'; uptime; echo '--- RAM ---'; free -m; echo '--- DISK ---'; df -h /"
    
    success, result = await ssh_manager.execute_command(target_ip, command)
    
    if success:
        await message.answer(f"✅ <b>Результат ({target_ip}):</b>\n<pre>{result}</pre>", parse_mode="HTML")
    else:
        await message.answer(f"❌ <b>Ошибка SSH ({target_ip}):</b>\n<pre>{result}</pre>", parse_mode="HTML")

from services.deployer import deployer

@router.message(Command("deploy"))
async def cmd_deploy(message: types.Message) -> None:
    if not message.from_user or not is_admin(message.from_user.id):
        return
    
    if not message.text:
        return
    # Ожидаем формат: /deploy <ip> <role> <password> <billing_date>
    args = message.text.split()
    if len(args) != 5:
        await message.answer("⚠️ Использование:\n<code>/deploy 192.168.1.10 ingress MyPass123 2026-05-30</code>", parse_mode="HTML")
        return

    ip, role, password, billing_date = args[1], args[2], args[3], args[4]
    
    await message.answer(f"⏳ Начинаю деплой ноды <b>{ip}</b> (Роль: {role}). Это займет 2-3 минуты...", parse_mode="HTML")
    
    success, result = await deployer.deploy_node(ip, role, password, billing_date)
    
    if success:
        await message.answer(f"✅ <b>Успех:</b>\n{result}", parse_mode="HTML")
    else:
        await message.answer(f"❌ <b>Ошибка деплоя:</b>\n<pre>{result}</pre>", parse_mode="HTML")

from services.marzban import marzban_manager

@router.message(Command("top_users"))
async def cmd_top_users(message: types.Message) -> None:
    if not message.from_user or not is_admin(message.from_user.id):
        return

    await message.answer("⏳ Собираю статистику из Marzban...")
    
    users = await marzban_manager.get_users()
    if not users:
        await message.answer("❌ Ошибка получения данных от Marzban API.")
        return

    # Сортируем пользователей по использованному трафику (по убыванию)
    active_users =[u for u in users if u.get("status") == "active"]
    sorted_users = sorted(active_users, key=lambda x: x.get("used_traffic", 0), reverse=True)
    
    top_5 = sorted_users[:5]
    
    text = "📊 <b>Топ-5 активных пользователей по трафику:</b>\n\n"
    for i, user in enumerate(top_5, 1):
        username = user.get("username")
        # Переводим байты в гигабайты
        used_gb = round(user.get("used_traffic", 0) / (1024**3), 2)
        limit_gb = round(user.get("data_limit", 0) / (1024**3), 2) if user.get("data_limit") else "∞"
        
        text += f"{i}. <code>{username}</code> — <b>{used_gb} GB</b> / {limit_gb} GB\n"

    await message.answer(text, parse_mode="HTML")
