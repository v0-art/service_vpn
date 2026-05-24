import logging
import aiohttp
from aiohttp import ClientTimeout
from typing import Optional, Dict, Any, List
from aiogram import Bot

from config import config
from bot.notifier import send_alert

logger = logging.getLogger(__name__)

class MarzbanManager:
    """
    Асинхронный клиент для работы с Marzban API.
    Отвечает за сбор статистики и поиск аномалий в трафике.
    """
    def __init__(self):
        self.base_url = config.MARZBAN_URL.rstrip('/')
        self.username = config.MARZBAN_USERNAME
        self.password = config.MARZBAN_PASSWORD
        self.token: Optional[str] = None
        
        # In-memory хранилище для отслеживания дельты трафика
        # Формат: {"username": used_traffic_bytes}
        self._traffic_state: Dict[str, int] = {}
        
        # Порог аномального трафика за один цикл проверки (например, 50 ГБ)
        self.ANOMALY_THRESHOLD_BYTES = 50 * 1024 * 1024 * 1024 

    async def _authenticate(self) -> bool:
        """Получение JWT токена администратора."""
        url = f"{self.base_url}/api/admin/token"
        data = {
            "username": self.username,
            "password": self.password
        }
        
        try:
            async with aiohttp.ClientSession() as session:
                async with session.post(url, data=data, timeout=ClientTimeout(total=10)) as response:
                    if response.status == 200:
                        result = await response.json()
                        self.token = result.get("access_token")
                        return True
                    else:
                        logger.error(f"Ошибка авторизации Marzban: HTTP {response.status}")
                        return False
        except Exception as e:
            logger.error(f"Сетевая ошибка при авторизации в Marzban: {e}")
            return False

    async def get_users(self) -> List[Dict[str, Any]]:
        """Получение списка всех пользователей."""
        if not self.token:
            if not await self._authenticate():
                return[]

        url = f"{self.base_url}/api/users"
        headers = {"Authorization": f"Bearer {self.token}", "accept": "application/json"}
        
        try:
            async with aiohttp.ClientSession() as session:
                async with session.get(url, headers=headers, timeout=ClientTimeout(total=15)) as response:
                    if response.status == 200:
                        return await response.json()
                    elif response.status == 401:
                        # Токен протух, пробуем переполучить
                        logger.warning("Токен Marzban истек. Обновляем...")
                        self.token = None
                        return await self.get_users()
                    else:
                        logger.error(f"Ошибка получения пользователей: HTTP {response.status}")
                        return[]
        except Exception as e:
            logger.error(f"Сетевая ошибка при запросе пользователей Marzban: {e}")
            return[]

    async def get_connection_status(self) -> Dict[str, Any]:
        """
        Проверяет доступность Marzban API и возвращает базовую информацию о соединении.
        """
        if not await self._authenticate():
            return {
                "connected": False,
                "users_count": 0,
                "error": "Ошибка авторизации в Marzban API.",
            }

        url = f"{self.base_url}/api/users"
        headers = {"Authorization": f"Bearer {self.token}", "accept": "application/json"}

        try:
            async with aiohttp.ClientSession() as session:
                async with session.get(url, headers=headers, timeout=ClientTimeout(total=15)) as response:
                    if response.status != 200:
                        return {
                            "connected": False,
                            "users_count": 0,
                            "error": f"HTTP {response.status}",
                        }

                    payload = await response.json()
                    users_count = len(payload) if isinstance(payload, list) else 0
                    return {
                        "connected": True,
                        "users_count": users_count,
                        "error": None,
                    }
        except Exception as e:
            logger.error(f"Сетевая ошибка при проверке Marzban API: {e}")
            return {
                "connected": False,
                "users_count": 0,
                "error": str(e),
            }

    async def check_traffic_anomalies(self, bot: Bot) -> None:
        """
        Проверяет трафик пользователей. Если кто-то скачал больше ANOMALY_THRESHOLD_BYTES
        с момента последней проверки, отправляет алерт администратору.
        """
        logger.info("Запуск проверки аномалий трафика в Marzban...")
        users = await self.get_users()
        
        if not users:
            logger.warning("Не удалось получить список пользователей для проверки трафика.")
            return

        for user in users:
            username = user.get("username")
            status = user.get("status")
            used_traffic = user.get("used_traffic", 0)

            if not username or status != "active":
                continue

            # Если пользователь уже есть в нашем in-memory стейте
            if username in self._traffic_state:
                previous_traffic = self._traffic_state[username]
                delta = used_traffic - previous_traffic

                # Проверяем на аномалию
                if delta > self.ANOMALY_THRESHOLD_BYTES:
                    delta_gb = round(delta / (1024**3), 2)
                    total_gb = round(used_traffic / (1024**3), 2)
                    
                    alert_msg = (
                        f"⚠️ <b>Аномальный трафик!</b>\n\n"
                        f"Пользователь: <code>{username}</code>\n"
                        f"Скачано за цикл: <b>{delta_gb} GB</b>\n"
                        f"Всего скачано: {total_gb} GB\n\n"
                        f"<i>Возможно, конфиг был скомпрометирован.</i>"
                    )
                    await send_alert(bot, alert_msg)
                    logger.warning(f"Аномалия трафика у {username}: {delta_gb} GB")

            # Обновляем стейт
            self._traffic_state[username] = used_traffic

marzban_manager = MarzbanManager()
