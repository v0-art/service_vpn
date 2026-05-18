import logging
import asyncssh
from typing import Tuple, Optional, Any
from config import config

logger = logging.getLogger(__name__)

class SSHManager:
    """
    Менеджер для асинхронного выполнения команд на удаленных серверах по SSH.
    Не использует агентов, работает напрямую с приватным ключом.
    """
    
    def __init__(self) -> None:
        self.default_user: str = config.SSH_DEFAULT_USER
        self.key_path: str = config.SSH_KEY_PATH

    async def execute_command(
        self, 
        host: str, 
        command: str, 
        user: Optional[str] = None,
        timeout: int = 30
    ) -> Tuple[bool, str]:
        """
        Выполняет bash-команду на удаленном сервере.
        
        :param host: IP-адрес сервера.
        :param command: Команда для выполнения.
        :param user: Имя пользователя (по умолчанию берется из config).
        :param timeout: Таймаут выполнения команды в секундах.
        :return: Кортеж (Успех: bool, Вывод_или_Ошибка: str)
        """
        target_user = user or self.default_user
        
        # Получаем индивидуальный SSH-ключ для этого хоста из БД, если он есть
        ssh_key_content: Optional[str] = None
        try:
            from db.database import get_db_connection
            async with get_db_connection() as db:
                async with db.execute("SELECT ssh_key FROM nodes WHERE ip = ?", (host,)) as cursor:
                    row = await cursor.fetchone()
                    if row and row["ssh_key"]:
                        ssh_key_content = row["ssh_key"]
        except Exception as e:
            logger.error(f"Не удалось получить индивидуальный SSH-ключ для {host} из БД: {e}")

        client_keys: Any = []
        if ssh_key_content:
            try:
                imported_key = asyncssh.import_private_key(ssh_key_content)
                client_keys.append(imported_key)
                logger.debug(f"Используется индивидуальный SSH-ключ для {host}")
            except Exception as e:
                logger.error(f"Ошибка парсинга индивидуального SSH-ключа для {host}: {e}")
                client_keys.append(self.key_path)
        else:
            client_keys.append(self.key_path)
        
        try:
            # known_hosts=None позволяет подключаться к новым нодам без ручного подтверждения fingerprint.
            # Для динамического кластера VPN это необходимо.
            async with asyncssh.connect(
                host, 
                username=target_user, 
                client_keys=client_keys, 
                known_hosts=None
            ) as conn:
                
                logger.debug(f"Выполнение команды на {host}: {command}")
                
                # Выполняем команду с заданным таймаутом
                result = await conn.run(command, check=False, timeout=timeout)
                
                def to_str(val: Any) -> str:
                    if val is None:
                        return ""
                    if isinstance(val, bytes):
                        return val.decode("utf-8", errors="replace")
                    return str(val)

                stdout_str = to_str(result.stdout).strip()
                stderr_str = to_str(result.stderr).strip()
                
                if result.exit_status == 0:
                    # Команда выполнена успешно
                    return True, stdout_str
                else:
                    # Команда завершилась с ошибкой (ненулевой код возврата)
                    error_msg = f"Код возврата: {result.exit_status}\nSTDERR: {stderr_str}"
                    logger.warning(f"Ошибка выполнения на {host}: {error_msg}")
                    return False, error_msg
                    
        except asyncssh.TimeoutError:
            error_msg = f"Таймаут ({timeout}с) при подключении или выполнении команды на {host}."
            logger.error(error_msg)
            return False, error_msg
            
        except asyncssh.PermissionDenied:
            error_msg = f"Отказано в доступе к {host}. Проверьте SSH-ключ ({self.key_path})."
            logger.error(error_msg)
            return False, error_msg
            
        except asyncssh.Error as e:
            error_msg = f"Ошибка протокола SSH при работе с {host}: {str(e)}"
            logger.error(error_msg)
            return False, error_msg
            
        except OSError as e:
            error_msg = f"Сетевая ошибка при подключении к {host}: {str(e)}"
            logger.error(error_msg)
            return False, error_msg
            
        except Exception as e:
            error_msg = f"Непредвиденная ошибка при работе с {host}: {str(e)}"
            logger.exception(error_msg)
            return False, error_msg

# Создаем глобальный экземпляр для импорта в другие модули
ssh_manager = SSHManager()