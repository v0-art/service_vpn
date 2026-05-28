import logging
import asyncssh
from typing import Tuple, Optional, Any
from config import config
from services.secrets import secret_manager

logger = logging.getLogger(__name__)

class SSHManager:
    """
    Менеджер для асинхронного выполнения команд на удаленных серверах по SSH.
    Не использует агентов, работает напрямую с приватным ключом.
    """
    
    def __init__(self) -> None:
        self.default_user: str = config.SSH_DEFAULT_USER
        self.key_path: str = config.SSH_KEY_PATH
        self.port: int = config.SSH_PORT

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
        
        # Получаем индивидуальные SSH-параметры для этого хоста из БД, если они есть
        ssh_key_content: Optional[str] = None
        ssh_password: Optional[str] = None
        target_port: int = self.port
        try:
            from db.database import get_db_connection
            async with get_db_connection() as db:
                async with db.execute(
                    "SELECT ssh_key, ssh_password, ssh_username, ssh_port FROM nodes WHERE ip = ?",
                    (host,),
                ) as cursor:
                    row = await cursor.fetchone()
                    if row:
                        if row["ssh_key"]:
                            ssh_key_content = secret_manager.decrypt(row["ssh_key"])
                        if row["ssh_password"]:
                            ssh_password = secret_manager.decrypt(row["ssh_password"])
                        if not user and row["ssh_username"]:
                            target_user = str(row["ssh_username"])
                        if row["ssh_port"]:
                            target_port = int(row["ssh_port"])
        except Exception as e:
            logger.error(f"Не удалось получить SSH-параметры для {host} из БД: {e}")

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
            if not ssh_password:
                client_keys.append(self.key_path)
        
        try:
            # known_hosts=None позволяет подключаться к новым нодам без ручного подтверждения fingerprint.
            # Для динамического кластера VPN это необходимо.
            async with asyncssh.connect(
                host, 
                port=target_port,
                username=target_user, 
                client_keys=client_keys, 
                password=ssh_password,
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
