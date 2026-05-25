import os
import aiosqlite
import logging

logger = logging.getLogger(__name__)

DB_PATH = os.getenv("DB_PATH", "luffy_cluster.db")
DEFAULT_SSH_PORT = int(os.getenv("SSH_PORT", "2222"))

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
            await db.execute(
                f'''
                CREATE TABLE IF NOT EXISTS nodes (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    name TEXT,
                    ip TEXT UNIQUE NOT NULL,
                    role TEXT NOT NULL, -- master, ingress, egress
                    billing_date TEXT NOT NULL,
                    status TEXT DEFAULT 'active',
                    ssh_key TEXT,
                    ssh_port INTEGER NOT NULL DEFAULT {DEFAULT_SSH_PORT},
                    inbound_tag TEXT,
                    inbound_port INTEGER,
                    group_sni TEXT,
                    fingerprint TEXT,
                    marzban_node_id INTEGER,
                    marzban_node_status TEXT DEFAULT 'unknown',
                    marzban_last_error TEXT,
                    provision_status TEXT DEFAULT 'pending'
                )
                '''
            )
            
            # Таблица глобальных настроек (ключ-значение)
            await db.execute('''
                CREATE TABLE IF NOT EXISTS settings (
                    key TEXT PRIMARY KEY,
                    value TEXT NOT NULL
                )
            ''')
            
            async def ensure_column(column_sql: str, column_name: str) -> None:
                try:
                    await db.execute(f"ALTER TABLE nodes ADD COLUMN {column_sql}")
                    await db.commit()
                    logger.info("Успешно добавлена колонка %s в таблицу nodes.", column_name)
                except aiosqlite.OperationalError:
                    pass

            # Автоматические миграции для старых инсталляций
            await ensure_column("name TEXT", "name")
            await ensure_column("ssh_key TEXT", "ssh_key")
            await ensure_column(f"ssh_port INTEGER NOT NULL DEFAULT {DEFAULT_SSH_PORT}", "ssh_port")
            await ensure_column("inbound_tag TEXT", "inbound_tag")
            await ensure_column("inbound_port INTEGER", "inbound_port")
            await ensure_column("group_sni TEXT", "group_sni")
            await ensure_column("fingerprint TEXT", "fingerprint")
            await ensure_column("marzban_node_id INTEGER", "marzban_node_id")
            await ensure_column("marzban_node_status TEXT DEFAULT 'unknown'", "marzban_node_status")
            await ensure_column("marzban_last_error TEXT", "marzban_last_error")
            await ensure_column("provision_status TEXT DEFAULT 'pending'", "provision_status")

            # Нормализуем ssh_port для уже существующих записей
            try:
                await db.execute(
                    "UPDATE nodes SET ssh_port = ? WHERE ssh_port IS NULL OR ssh_port <= 0",
                    (DEFAULT_SSH_PORT,),
                )
                await db.commit()
            except aiosqlite.OperationalError:
                # На случай нестандартной старой схемы
                pass

            # Нормализуем дополнительные поля
            try:
                await db.execute("UPDATE nodes SET name = ip WHERE name IS NULL OR name = ''")
                await db.execute(
                    "UPDATE nodes SET inbound_tag = 'IN-RU-DIRECT' WHERE inbound_tag IS NULL OR inbound_tag = ''"
                )
                await db.execute(
                    "UPDATE nodes SET inbound_port = 443 WHERE inbound_port IS NULL OR inbound_port <= 0"
                )
                await db.execute(
                    "UPDATE nodes SET group_sni = ip WHERE group_sni IS NULL OR group_sni = ''"
                )
                await db.execute(
                    "UPDATE nodes SET fingerprint = 'chrome' WHERE fingerprint IS NULL OR fingerprint = ''"
                )
                await db.execute(
                    "UPDATE nodes SET provision_status = 'pending' WHERE provision_status IS NULL OR provision_status = ''"
                )
                await db.execute(
                    "UPDATE nodes SET marzban_node_status = 'unknown' WHERE marzban_node_status IS NULL OR marzban_node_status = ''"
                )
                await db.commit()
            except aiosqlite.OperationalError:
                pass
            
            await db.commit()
            logger.info("База данных успешно инициализирована (WAL-режим активен).")
    except Exception as e:
        logger.critical(f"Критическая ошибка при инициализации БД: {e}")
        raise
