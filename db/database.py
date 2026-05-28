import os
import aiosqlite
import logging
import time

logger = logging.getLogger(__name__)

DB_PATH = os.getenv("DB_PATH", "luffy_cluster.db")
DEFAULT_SSH_PORT = int(os.getenv("SSH_PORT", "2222"))
DEFAULT_SSH_USER = os.getenv("SSH_DEFAULT_USER", "root")

from contextlib import asynccontextmanager

@asynccontextmanager
async def get_db_connection():
    """
    Создает и возвращает асинхронное подключение к БД.
    Включает WAL-режим для безопасного конкурентного чтения/записи.
    """
    conn = await aiosqlite.connect(DB_PATH)
    conn.row_factory = aiosqlite.Row
    await conn.execute("PRAGMA foreign_keys=ON;")
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

            await db.execute('''
                CREATE TABLE IF NOT EXISTS node_roles (
                    node_id INTEGER NOT NULL,
                    role TEXT NOT NULL,
                    created_at INTEGER NOT NULL DEFAULT 0,
                    PRIMARY KEY (node_id, role),
                    FOREIGN KEY (node_id) REFERENCES nodes(id) ON DELETE CASCADE
                )
            ''')

            await db.execute('''
                CREATE TABLE IF NOT EXISTS node_inbounds (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    node_id INTEGER NOT NULL,
                    inbound_tag TEXT NOT NULL,
                    remark TEXT NOT NULL,
                    address TEXT NOT NULL,
                    port INTEGER,
                    sni TEXT,
                    host TEXT,
                    fingerprint TEXT,
                    security TEXT,
                    alpn TEXT,
                    is_disabled INTEGER NOT NULL DEFAULT 0,
                    original_remark TEXT,
                    raw_json TEXT,
                    updated_at INTEGER NOT NULL DEFAULT 0,
                    UNIQUE(node_id, inbound_tag, remark, address),
                    FOREIGN KEY (node_id) REFERENCES nodes(id) ON DELETE CASCADE
                )
            ''')

            await db.execute("CREATE INDEX IF NOT EXISTS idx_node_inbounds_node_id ON node_inbounds(node_id)")
            await db.execute("CREATE INDEX IF NOT EXISTS idx_node_inbounds_address ON node_inbounds(address)")
            
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
            await ensure_column("ssh_username TEXT", "ssh_username")
            await ensure_column("ssh_password TEXT", "ssh_password")
            await ensure_column("credential_status TEXT DEFAULT 'missing'", "credential_status")
            await ensure_column("marzban_node_name TEXT", "marzban_node_name")
            await ensure_column("marzban_node_port INTEGER", "marzban_node_port")
            await ensure_column("marzban_node_api_port INTEGER", "marzban_node_api_port")
            await ensure_column("marzban_usage_coefficient REAL", "marzban_usage_coefficient")
            await ensure_column("marzban_node_raw TEXT", "marzban_node_raw")
            await ensure_column("last_marzban_sync INTEGER", "last_marzban_sync")

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
                await db.execute(
                    "UPDATE nodes SET ssh_username = ? WHERE ssh_username IS NULL OR ssh_username = ''",
                    (DEFAULT_SSH_USER,),
                )
                await db.execute(
                    """
                    UPDATE nodes
                    SET credential_status = CASE
                        WHEN ssh_key IS NOT NULL AND ssh_key != '' THEN 'configured'
                        WHEN ssh_password IS NOT NULL AND ssh_password != '' THEN 'configured'
                        ELSE 'missing'
                    END
                    WHERE credential_status IS NULL OR credential_status = ''
                    """
                )
                await db.commit()
            except aiosqlite.OperationalError:
                pass

            now = int(time.time())
            try:
                await db.execute(
                    """
                    INSERT OR IGNORE INTO node_roles (node_id, role, created_at)
                    SELECT
                        id,
                        CASE
                            WHEN role = 'master' THEN 'master'
                            WHEN role = 'egress' THEN 'direct_eu'
                            ELSE 'direct_ru'
                        END,
                        ?
                    FROM nodes
                    WHERE role IS NOT NULL AND role != ''
                    """,
                    (now,),
                )
                await db.commit()
            except aiosqlite.OperationalError:
                pass

            try:
                from services.secrets import secret_manager

                if secret_manager.can_encrypt():
                    async with db.execute("SELECT id, ssh_key, ssh_password FROM nodes") as cursor:
                        rows = await cursor.fetchall()

                    for row in rows:
                        updates = {}
                        if row["ssh_key"] and not secret_manager.is_encrypted(row["ssh_key"]):
                            updates["ssh_key"] = secret_manager.encrypt(row["ssh_key"])
                        if row["ssh_password"] and not secret_manager.is_encrypted(row["ssh_password"]):
                            updates["ssh_password"] = secret_manager.encrypt(row["ssh_password"])

                        if updates:
                            assignments = ", ".join(f"{field} = ?" for field in updates)
                            values = list(updates.values())
                            values.append(row["id"])
                            await db.execute(f"UPDATE nodes SET {assignments} WHERE id = ?", values)

                    await db.commit()
            except Exception as exc:
                logger.error("Не удалось зашифровать существующие SSH credentials: %s", exc)
            
            await db.commit()
            logger.info("База данных успешно инициализирована (WAL-режим активен).")
    except Exception as e:
        logger.critical(f"Критическая ошибка при инициализации БД: {e}")
        raise
