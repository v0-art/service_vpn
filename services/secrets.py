import base64
import hashlib
import logging
from typing import Optional

from cryptography.fernet import Fernet, InvalidToken

from config import config

logger = logging.getLogger(__name__)

ENCRYPTED_PREFIX = "enc:v1:"


class SecretManager:
    """
    Small encryption wrapper for credentials stored in SQLite.

    If MASTER_SECRET_KEY is missing, values are stored as plaintext to keep old
    installations working. Production installs should set MASTER_SECRET_KEY.
    """

    def __init__(self) -> None:
        self._fernet: Optional[Fernet] = self._build_fernet(config.MASTER_SECRET_KEY)
        if not self._fernet:
            logger.warning("MASTER_SECRET_KEY is not set; credentials will be stored unencrypted.")

    def _build_fernet(self, secret: str) -> Optional[Fernet]:
        raw = (secret or "").strip()
        if not raw:
            return None

        if raw.startswith("fernet:"):
            raw = raw.removeprefix("fernet:")
            try:
                return Fernet(raw.encode("utf-8"))
            except Exception as exc:
                logger.error("Invalid fernet MASTER_SECRET_KEY: %s", exc)
                return None

        digest = hashlib.sha256(raw.encode("utf-8")).digest()
        key = base64.urlsafe_b64encode(digest)
        return Fernet(key)

    def encrypt(self, value: Optional[str]) -> Optional[str]:
        if value is None:
            return None
        if value == "":
            return ""
        if value.startswith(ENCRYPTED_PREFIX):
            return value
        if not self._fernet:
            return value
        token = self._fernet.encrypt(value.encode("utf-8")).decode("utf-8")
        return f"{ENCRYPTED_PREFIX}{token}"

    def decrypt(self, value: Optional[str]) -> Optional[str]:
        if value is None:
            return None
        if not value.startswith(ENCRYPTED_PREFIX):
            return value
        if not self._fernet:
            logger.error("Cannot decrypt credential: MASTER_SECRET_KEY is not configured.")
            return None
        token = value.removeprefix(ENCRYPTED_PREFIX)
        try:
            return self._fernet.decrypt(token.encode("utf-8")).decode("utf-8")
        except InvalidToken:
            logger.error("Cannot decrypt credential: invalid token or MASTER_SECRET_KEY.")
            return None

    def is_encrypted(self, value: Optional[str]) -> bool:
        return bool(value and value.startswith(ENCRYPTED_PREFIX))

    def can_encrypt(self) -> bool:
        return self._fernet is not None


secret_manager = SecretManager()
