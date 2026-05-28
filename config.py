import os
import re
from pydantic_settings import BaseSettings, SettingsConfigDict


def _normalize_secret(value: str) -> str:
    normalized = value.strip()

    if (
        len(normalized) >= 2
        and normalized[0] == normalized[-1]
        and normalized[0] in {"'", '"'}
    ):
        normalized = normalized[1:-1]

    # Поддерживаем экранирование спецсимволов в .env (\#, \&, \*, \!, \\)
    normalized = (
        normalized.replace(r"\#", "#")
        .replace(r"\&", "&")
        .replace(r"\*", "*")
        .replace(r"\!", "!")
        .replace(r"\\", "\\")
    )
    return normalized


def _read_raw_env_value(key: str, env_file: str = ".env") -> str | None:
    if not os.path.exists(env_file):
        return None

    key_prefix = f"{key}="
    try:
        with open(env_file, "r", encoding="utf-8") as file:
            for raw_line in file:
                line = raw_line.strip()
                if not line or line.startswith("#"):
                    continue

                if line.startswith("export "):
                    line = line[7:].lstrip()

                if not line.startswith(key_prefix):
                    continue

                value = line.split("=", 1)[1].strip()
                if not value:
                    return ""

                # Для unquoted значений убираем только комментарий в формате " ... #comment"
                if value[0] not in {"'", '"'}:
                    value = re.split(r"\s+#", value, maxsplit=1)[0].rstrip()

                return _normalize_secret(value)
    except OSError:
        return None

    return None


class Settings(BaseSettings):
    # Telegram
    BOT_TOKEN: str = "123456789:AAG_fake_token_placeholder_for_validation"
    ADMIN_ID: int = 0

    # SSH
    SSH_DEFAULT_USER: str = "root"
    SSH_KEY_PATH: str = os.path.expanduser("~/.ssh/id_rsa")
    SSH_PORT: int = 2222
    MASTER_SECRET_KEY: str = ""

    # Web
    WEB_HOST: str = "127.0.0.1"
    WEB_PORT: int = 8080
    WEB_APP_URL: str = ""
    WEB_APP_VERSION: str = ""

    # Настройки Pydantic для чтения из .env файла
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")
    # Marzban API
    MARZBAN_URL: str = "http://127.0.0.1:8000"
    MARZBAN_USERNAME: str = "admin"
    MARZBAN_PASSWORD: str = "admin"
    MARZBAN_INSECURE_TLS: bool = True

    def model_post_init(self, __context: object) -> None:
        # Для Marzban берем raw-значения из .env, чтобы спецсимволы не терялись.
        raw_username = _read_raw_env_value("MARZBAN_USERNAME")
        raw_password = _read_raw_env_value("MARZBAN_PASSWORD")

        if raw_username is not None and raw_username != "":
            self.MARZBAN_USERNAME = raw_username
        else:
            self.MARZBAN_USERNAME = _normalize_secret(self.MARZBAN_USERNAME)

        if raw_password is not None and raw_password != "":
            self.MARZBAN_PASSWORD = raw_password
        else:
            self.MARZBAN_PASSWORD = _normalize_secret(self.MARZBAN_PASSWORD)

# Глобальный объект настроек
config = Settings()
