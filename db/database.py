import os
import aiosqlite
import logging
from typing import Optional

logger = logging.getLogger(__name__)

DB_PATH = os.getenv("DB_PATH", "luffy_cluster.db")

from contextlib import asynccontextmanager

@asynccontextmanager
async def get_db_connection():
    """
    Создает и возвращает асинхронное подключение к БД.
    Включает WAL-режим для безопасного конкурентного чтения/записи.
    """
    conn = await aiosqlite.connect(DB_PATH)
    conn.row_factory = aiosqlite.Row
    # Включаем Write-Ahead Logging
    await conn.execute("PRAGMA journal_mode=WAL;")
    # Оптимизация синхронизации для WAL
    await conn.execute("PRAGMA synchronous=NORMAL;")
    try:
        yield conn
    finally:
        await conn.close()

async def init_db() -> None:
    """
    Инициализация структуры базы данных.
    Создает таблицы nodes и settings, если они не существуют.
    """
    try:
        async with get_db_connection() as db:
            # Таблица серверов (нод)
            await db.execute('''
                CREATE TABLE IF NOT EXISTS nodes (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    ip TEXT UNIQUE NOT NULL,
                    role TEXT NOT NULL, -- master, ingress, egress
                    billing_date TEXT NOT NULL,
                    status TEXT DEFAULT 'active',
                    ssh_key TEXT
                )
            ''')
            
            # Таблица глобальных настроек (ключ-значение)
            await db.execute('''
                CREATE TABLE IF NOT EXISTS settings (
                    key TEXT PRIMARY KEY,
                    value TEXT NOT NULL
                )
            ''')
            
            # Автоматическая миграция для добавления колонки ssh_key, если её нет
            try:
                await db.execute("ALTER TABLE nodes ADD COLUMN ssh_key TEXT")
                await db.commit()
                logger.info("Успешно добавлена колонка ssh_key в таблицу nodes.")
            except aiosqlite.OperationalError:
                # Колонка уже существует, игнорируем ошибку
                pass
            
            await db.commit()
            logger.info("База данных успешно инициализирована (WAL-режим активен).")
    except Exception as e:
        logger.critical(f"Критическая ошибка при инициализации БД: {e}")
        raise