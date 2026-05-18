import logging
from aiogram import Bot
from config import config

logger = logging.getLogger(__name__)

async def send_alert(bot: Bot, message: str) -> None:
    """
    Отправляет экстренное уведомление администратору.
    """
    try:
        text = f"🚨 <b>SYSTEM ALERT</b> 🚨\n\n{message}"
        await bot.send_message(chat_id=config.ADMIN_ID, text=text, parse_mode="HTML")
        logger.info("Алерт успешно отправлен администратору.")
    except Exception as e:
        logger.error(f"Ошибка при отправке алерта администратору: {e}")