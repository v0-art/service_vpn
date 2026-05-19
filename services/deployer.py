import os
import logging
import asyncssh
from typing import Tuple

from config import config
from db.database import get_db_connection
from services.ssh_manager import ssh_manager

logger = logging.getLogger(__name__)

class NodeDeployer:
    """
    Модуль для автоматического развертывания Ingress и Egress нод.
    """
    def __init__(self):
        self.pub_key_path = f"{config.SSH_KEY_PATH}.pub"

    async def _inject_ssh_key(self, ip: str, password: str, public_key_str: str) -> Tuple[bool, str]:
        """
        Подключается к серверу по паролю и добавляет публичный ключ в authorized_keys.
        """
        setup_script = f"""
        mkdir -p ~/.ssh
        chmod 700 ~/.ssh
        echo "{public_key_str}" >> ~/.ssh/authorized_keys
        chmod 600 ~/.ssh/authorized_keys
        # Отключаем вход по паролю для безопасности (опционально, закомментировано для тестов)
        # sed -i 's/#PasswordAuthentication yes/PasswordAuthentication no/' /etc/ssh/sshd_config
        # systemctl restart sshd
        """

        try:
            # Подключаемся строго по паролю для первичной настройки
            async with asyncssh.connect(
                ip, 
                port=config.SSH_PORT,
                username=config.SSH_DEFAULT_USER, 
                password=password, 
                known_hosts=None
            ) as conn:
                result = await conn.run(setup_script, check=False)
                if result.exit_status == 0:
                    return True, "SSH ключ успешно установлен."
                return False, f"Ошибка установки ключа: {result.stderr}"
        except Exception as e:
            logger.error(f"Ошибка инъекции ключа на {ip}: {e}")
            return False, str(e)

    async def deploy_node(self, ip: str, role: str, password: str, billing_date: str) -> Tuple[bool, str]:
        """
        Главный метод деплоя.
        1. Генерирует уникальный SSH-ключ для этой конкретной ноды.
        2. Прокидывает публичный ключ на ноду по паролю.
        3. Записывает ноду во временное состояние в БД с её приватным ключом.
        4. Запускает bash-скрипт настройки по SSH с использованием свежесозданного ключа.
        5. Финализирует в БД.
        """
        logger.info(f"Начинаем деплой ноды {ip} с ролью {role}...")

        # Шаг 1: Генерация индивидуального ключа
        try:
            generated_key = asyncssh.generate_private_key('ssh-rsa', key_size=2048)
            private_key_str = generated_key.export_private_key().decode('utf-8')
            public_key_str = generated_key.export_public_key().decode('utf-8').strip()
        except Exception as e:
            logger.error(f"Не удалось сгенерировать SSH-ключ для ноды {ip}: {e}")
            return False, f"Ошибка генерации SSH-ключа: {e}"

        # Шаг 2: Установка SSH ключа
        key_success, key_msg = await self._inject_ssh_key(ip, password, public_key_str)
        if not key_success:
            return False, f"Сбой на этапе авторизации: {key_msg}"

        # Шаг 3: Временное добавление в БД, чтобы ssh_manager мог использовать этот ключ во время деплоя
        try:
            async with get_db_connection() as db:
                # Сначала удалим старую запись, если она была (для чистоты)
                await db.execute("DELETE FROM nodes WHERE ip = ?", (ip,))
                await db.execute(
                    "INSERT INTO nodes (ip, role, billing_date, status, ssh_key) VALUES (?, ?, ?, 'active', ?)",
                    (ip, role, billing_date, private_key_str)
                )
                await db.commit()
        except Exception as e:
            logger.error(f"Ошибка предварительного сохранения ключа ноды {ip} в БД: {e}")
            return False, "Не удалось сохранить SSH-ключ в базу данных."

        # Шаг 4: Выбор и запуск скрипта настройки
        if role == "ingress":
            script = self._get_ingress_script()
        elif role == "egress":
            script = self._get_egress_script()
        else:
            # Откатываем временную запись в случае ошибки
            async with get_db_connection() as db:
                await db.execute("DELETE FROM nodes WHERE ip = ?", (ip,))
                await db.commit()
            return False, f"Неизвестная роль: {role}"

        logger.info(f"Запуск конфигурационного скрипта на {ip}...")
        # Теперь ssh_manager автоматически подхватит сохраненный private_key_str из БД!
        deploy_success, deploy_result = await ssh_manager.execute_command(ip, script, timeout=300)

        if not deploy_success:
            # Удаляем запись о ноде из БД, так как деплой провалился
            async with get_db_connection() as db:
                await db.execute("DELETE FROM nodes WHERE ip = ?", (ip,))
                await db.commit()
            return False, f"Ошибка при выполнении скрипта деплоя:\n{deploy_result}"

        return True, f"Нода {ip} ({role}) успешно развернута, защищена уникальным ключом и добавлена в кластер!"

    def _get_ingress_script(self) -> str:
        """Bash-скрипт для настройки Ingress-ноды (Москва)."""
        return """
        #!/bin/bash
        set -e # Остановка при любой ошибке
        
        echo "=== Обновление системы ==="
        DEBIAN_FRONTEND=noninteractive apt-get update -y
        DEBIAN_FRONTEND=noninteractive apt-get install -y curl ufw haproxy nginx unzip
        
        echo "=== Настройка UFW ==="
        ufw --force reset
        ufw default deny incoming
        ufw default allow outgoing
        ufw allow 22/tcp
        ufw allow 443/tcp   # Входящий клиентский трафик
        ufw allow 2096/tcp  # Трафик подписок
        ufw --force enable
        
        echo "=== Настройка Nginx (Decoy) ==="
        cat << 'EOF' > /etc/nginx/sites-available/default
server {
    listen 8449;
    server_name _;
    location / {
        return 200 "Storage Gateway OK\n";
    }
}
EOF
        systemctl restart nginx
        systemctl enable nginx
        
        echo "=== Установка Xray Core ==="
        bash -c "$(curl -L https://github.com/XTLS/Xray-install/raw/main/install-release.sh)" @ install
        systemctl enable xray
        
        echo "=== Деплой Ingress завершен ==="
        """

    def _get_egress_script(self) -> str:
        """Bash-скрипт для настройки Egress-ноды (Европа)."""
        return """
        #!/bin/bash
        set -e
        
        echo "=== Обновление системы ==="
        DEBIAN_FRONTEND=noninteractive apt-get update -y
        DEBIAN_FRONTEND=noninteractive apt-get install -y curl ufw unzip
        
        echo "=== Настройка UFW ==="
        ufw --force reset
        ufw default deny incoming
        ufw default allow outgoing
        ufw allow 22/tcp
        # Разрешаем входящий трафик только от Ingress нод (в реале нужно подставлять IP)
        ufw allow 443/tcp 
        ufw --force enable
        
        echo "=== Оптимизация ядра (BBR) ==="
        cat << 'EOF' > /etc/sysctl.d/99-bbr.conf
net.core.default_qdisc=fq
net.ipv4.tcp_congestion_control=bbr
net.ipv4.ip_forward=1
EOF
        sysctl --system
        
        echo "=== Установка Xray Core ==="
        bash -c "$(curl -L https://github.com/XTLS/Xray-install/raw/main/install-release.sh)" @ install
        systemctl enable xray
        
        echo "=== Деплой Egress завершен ==="
        """

deployer = NodeDeployer()