import os
from pydantic_settings import BaseSettings, SettingsConfigDict

class Settings(BaseSettings):
    # Telegram
    BOT_TOKEN: str = ""
    ADMIN_ID: int = 0

    # SSH
    SSH_DEFAULT_USER: str = "root"
    SSH_KEY_PATH: str = os.path.expanduser("~/.ssh/id_rsa")
    SSH_PORT: int = 2222

    # Web
    WEB_HOST: str = "127.0.0.1"
    WEB_PORT: int = 8080

    # Настройки Pydantic для чтения из .env файла
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")
    # Marzban API
    MARZBAN_URL: str = "http://127.0.0.1:8000"
    MARZBAN_USERNAME: str = "admin"
    MARZBAN_PASSWORD: str = "admin"

# Глобальный объект настроек
config = Settings()