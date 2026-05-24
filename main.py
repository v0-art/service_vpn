import asyncio
import logging
import os
from logging.handlers import RotatingFileHandler
import uvicorn
from aiogram import Bot, Dispatcher
from fastapi import FastAPI, Request
from fastapi.responses import PlainTextResponse, Response
from bot.handlers import router
from fastapi.staticfiles import StaticFiles
from web.api import router as api_router
from bot.handlers import router as bot_router
from bot.middlewares import AntiFloodMiddleware
from db.database import init_db
from services.monitor import setup_scheduler, shutdown_scheduler
from config import config

# Убедимся, что папка для логов существует
os.makedirs("logs", exist_ok=True)

# Настройка централизованного логирования (с ротацией: 5 файлов по 10 МБ)
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
    handlers=[
        RotatingFileHandler("logs/tower.log", maxBytes=10*1024*1024, backupCount=5, encoding="utf-8"),
        logging.StreamHandler()
    ]
)
logger = logging.getLogger(__name__)

# ==========================================
# Инициализация компонентов (Заглушки для старта)
# В будущем вынесем в web/api.py и bot/handlers.py
# ==========================================

# 1. FastAPI
app = FastAPI(title="LUFFY Control Tower API", version="2.6")
# Подключаем API роутер
app.include_router(api_router)


def _is_telegram_webapp_request(request: Request) -> bool:
    """
    Минимальная серверная проверка, что UI открывают из Telegram WebApp.
    """
    user_agent = request.headers.get("user-agent", "")
    referer = request.headers.get("referer", "")
    query = request.query_params

    has_telegram_user_agent = "Telegram" in user_agent
    has_telegram_query_markers = any(
        marker in query
        for marker in ("tgWebAppData", "tgWebAppVersion", "tgWebAppPlatform", "tgWebAppThemeParams")
    )
    has_telegram_referer = "telegram.org" in referer or "t.me" in referer

    return has_telegram_user_agent or has_telegram_query_markers or has_telegram_referer


@app.middleware("http")
async def restrict_external_panel_access(request: Request, call_next) -> Response:
    """
    Блокирует публичный внешний вход в Mini App UI.
    API и /health остаются доступны для штатной работы.
    """
    path = request.url.path

    if path.startswith("/api") or path == "/health":
        return await call_next(request)

    if _is_telegram_webapp_request(request):
        return await call_next(request)

    return PlainTextResponse("404 Not Found", status_code=404)

@app.get("/health")
async def health_check() -> dict[str, str]:
    """Эндпоинт для проверки жизнеспособности API."""
    return {"status": "ok", "component": "FastAPI"}

# Раздаем статику (Mini App)
# Важно: папка static должна существовать в корне проекта
app.mount("/", StaticFiles(directory="static", html=True), name="static")

# 2. Aiogram Bot
BOT_TOKEN = config.BOT_TOKEN
bot = Bot(token=BOT_TOKEN)
dp = Dispatcher()
dp.message.middleware(AntiFloodMiddleware(time_limit=3))

# ==========================================
# Асинхронные функции запуска
# ==========================================

async def start_fastapi() -> None:
    """Программный запуск FastAPI сервера через uvicorn."""
    uvicorn_config = uvicorn.Config(
        app=app,
        host=config.WEB_HOST,
        port=config.WEB_PORT,
        log_level="info"
    )
    server = uvicorn.Server(uvicorn_config)
    logger.info(f"Запуск FastAPI сервера на {config.WEB_HOST}:{config.WEB_PORT}...")
    await server.serve()

async def start_bot() -> None:
    """Запуск Telegram бота (Long Polling)."""
    logger.info("Запуск Aiogram бота...")
    try:
        # Пропускаем накопившиеся апдейты при старте (опционально)
        await bot.delete_webhook(drop_pending_updates=True)
        dp.include_router(router)
        await dp.start_polling(bot)
    except Exception as e:
        logger.error(f"Критическая ошибка запуска Telegram-бота: {e}. Проверьте правильность BOT_TOKEN в файле .env")

async def main() -> None:
    """Главная точка входа: инициализация БД и параллельный запуск сервисов."""
    logger.info("Инициализация LUFFY Control Tower v2.6...")
    
    # 1. Подготовка инфраструктуры
    await init_db()
    
    # 2. Запуск фонового мониторинга (SRE)
    setup_scheduler(bot)
    
    # 3. Параллельный запуск Web-сервера и Бота
    try:
        await asyncio.gather(
            start_fastapi(),
            start_bot()
        )
    except Exception as e:
        logger.error(f"Ошибка во время выполнения: {e}")
    finally:
        # Корректное закрытие сессий при остановке
        shutdown_scheduler()
        await bot.session.close()
        logger.info("Сессия бота закрыта.")

if __name__ == "__main__":
    try:
        asyncio.run(main())
    except (KeyboardInterrupt, SystemExit):
        logger.info("LUFFY Control Tower корректно остановлен.")
