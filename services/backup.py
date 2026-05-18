import logging
import aiosqlite
import os
from aiogram import Bot
from aiogram.types import FSInputFile
from db.database import DB_PATH

logger = logging.getLogger(__name__)

async def backup_database(bot: Bot) -> None:
    """
    Делает горячий бэкап БД SQLite (безопасно для WAL).
    Отправляет .db файл в Telegram.
    """
    logger.info("Запуск создания бэкапа базы данных...")
    backup_path = f"backup_{DB_PATH}"
    
    try:
        # Create a hot backup using aiosqlite's wrapper for sqlite3's backup API
        async with aiosqlite.connect(DB_PATH) as db:
            async with aiosqlite.connect(backup_path) as backup_db:
                await db.backup(backup_db)
                
        logger.info(f"Бэкап успешно создан: {backup_path}")
        
        # Отправляем в Telegram
        # Попытаемся получить ADMIN_ID из .env или config
        from config import config as settings
        admin_id = settings.ADMIN_ID
        
        document = FSInputFile(backup_path, filename=backup_path)
        await bot.send_document(
            chat_id=admin_id,
            document=document,
            caption="📦 <b>Еженедельный бэкап базы данных (WAL-safe)</b>",
            parse_mode="HTML"
        )
        logger.info("Бэкап отправлен в Telegram.")
        
    except Exception as e:
        logger.error(f"Ошибка при создании или отправке бэкапа: {e}")
        from bot.notifier import send_alert
        await send_alert(bot, f"❌ <b>Ошибка бэкапа БД!</b>\n{e}")
    finally:
        # Удаляем временный файл бэкапа
        if os.path.exists(backup_path):
            os.remove(backup_path)
