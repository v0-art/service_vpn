import logging
from services.ssh_manager import ssh_manager

logger = logging.getLogger(__name__)

class HAProxyManager:
    """
    Сервис для безопасного обновления конфигурации HAProxy на Ingress/Master нодах.
    """
    
    def __init__(self):
        self.config_path = "/etc/haproxy/haproxy.cfg"
        self.test_config_path = "/tmp/haproxy_test.cfg"

    async def apply_config(self, host: str, new_config_content: str) -> tuple[bool, str]:
        """
        Безопасно применяет новый конфиг HAProxy.
        1. Записывает во временный файл.
        2. Проверяет синтаксис (haproxy -c).
        3. Если ОК -> делает бэкап старого, заменяет, перезапускает systemd.
        4. Если ОШИБКА -> возвращает лог ошибки, основной конфиг не трогает.
        """
        logger.info(f"Начинаем безопасное обновление HAProxy на {host}")

        # Экранируем возможные спецсимволы bash (хотя 'EOF' защищает от подстановки переменных)
        # Формируем команду, которая выполнит все шаги за одну SSH-сессию для скорости и надежности
        
        bash_script = f"""
        # 1. Записываем новый конфиг во временный файл
        cat << 'EOF_LUFFY_HAPROXY' > {self.test_config_path}
{new_config_content}
EOF_LUFFY_HAPROXY

        # 2. Проверяем синтаксис
        if haproxy -c -f {self.test_config_path}; then
            echo "SYNTAX_OK"
            # 3. Делаем бэкап текущего конфига
            cp {self.config_path} {self.config_path}.bak
            
            # 4. Применяем новый конфиг
            mv {self.test_config_path} {self.config_path}
            
            # 5. Перезапускаем сервис
            systemctl restart haproxy
            
            # Проверяем статус сервиса после рестарта
            if systemctl is-active --quiet haproxy; then
                echo "RESTART_SUCCESS"
            else
                echo "RESTART_FAILED"
                # Экстренный откат, если сервис упал после рестарта
                mv {self.config_path}.bak {self.config_path}
                systemctl restart haproxy
            fi
        else
            echo "SYNTAX_ERROR"
        fi
        """

        success, result = await ssh_manager.execute_command(host, bash_script)

        if not success:
            return False, f"Ошибка выполнения скрипта деплоя:\n{result}"

        # Анализируем вывод нашего bash-скрипта
        if "SYNTAX_ERROR" in result:
            # Извлекаем только ошибки HAProxy из вывода
            error_lines =[line for line in result.split('\n') if "SYNTAX_ERROR" not in line and "EOF_LUFFY" not in line]
            return False, f"Синтаксическая ошибка в конфигурации. Откат выполнен.\nДетали:\n{chr(10).join(error_lines)}"
            
        if "RESTART_FAILED" in result:
            return False, "Синтаксис верен, но HAProxy не смог запуститься. Выполнен откат на предыдущую версию."

        if "SYNTAX_OK" in result and "RESTART_SUCCESS" in result:
            return True, "Конфигурация HAProxy успешно обновлена и применена."

        return False, f"Неизвестный ответ от сервера:\n{result}"

haproxy_manager = HAProxyManager()