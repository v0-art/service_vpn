import time
from typing import Callable, Dict, Any, Awaitable
from aiogram import BaseMiddleware
from aiogram.types import TelegramObject, Message

class AntiFloodMiddleware(BaseMiddleware):
    """
    Простая защита от флуда в боте.
    Блокирует сообщения, если они отправляются чаще, чем указано в time_limit (в секундах).
    """
    def __init__(self, time_limit: int = 2):
        self.time_limit = time_limit
        self.users_cache: Dict[int, float] = {}

    async def __call__(
        self,
        handler: Callable[[TelegramObject, Dict[str, Any]], Awaitable[Any]],
        event: TelegramObject,
        data: Dict[str, Any]
    ) -> Any:
        if not isinstance(event, Message) or not event.from_user:
            return await handler(event, data)
        user_id = event.from_user.id
        current_time = time.time()
        
        last_request_time = self.users_cache.get(user_id)
        if last_request_time is not None:
            time_diff = current_time - last_request_time
            if time_diff < self.time_limit:
                # Игнорируем запрос (спам)
                return
                
        self.users_cache[user_id] = current_time
        return await handler(event, data)
