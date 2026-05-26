import logging
from typing import Optional, Dict, Any, List, Tuple

import aiohttp
from aiohttp import ClientTimeout
from aiogram import Bot

from config import config
from bot.notifier import send_alert

logger = logging.getLogger(__name__)


class MarzbanManager:
    """
    Асинхронный клиент Marzban API:
    - авторизация и проверка соединения
    - работа с users
    - базовые операции с node/hosts для автоматизации нод
    """

    def __init__(self) -> None:
        self.base_url = config.MARZBAN_URL.rstrip("/")
        self.username = config.MARZBAN_USERNAME
        self.password = config.MARZBAN_PASSWORD
        self.insecure_tls = bool(config.MARZBAN_INSECURE_TLS)
        self.token: Optional[str] = None
        self.last_auth_status: Optional[int] = None
        self.last_auth_error: Optional[str] = None

        # In-memory состояние для эвристики аномалий
        self._traffic_state: Dict[str, int] = {}
        self.ANOMALY_THRESHOLD_BYTES = 50 * 1024 * 1024 * 1024

    def _ssl_option(self) -> bool:
        """
        Для self-signed Marzban TLS можно отключить проверку сертификата.
        """
        if self.base_url.startswith("https://") and self.insecure_tls:
            return False
        return True

    async def _authenticate(self, force: bool = False) -> bool:
        if self.token and not force:
            return True

        url = f"{self.base_url}/api/admin/token"
        data = {
            "grant_type": "password",
            "username": self.username,
            "password": self.password,
        }

        try:
            async with aiohttp.ClientSession() as session:
                async with session.post(
                    url,
                    data=data,
                    timeout=ClientTimeout(total=10),
                    ssl=self._ssl_option(),
                ) as response:
                    if response.status == 200:
                        result = await response.json()
                        self.token = result.get("access_token")
                        self.last_auth_status = 200
                        self.last_auth_error = None
                        return bool(self.token)

                    self.token = None
                    self.last_auth_status = response.status
                    self.last_auth_error = await response.text()
                    logger.error("Ошибка авторизации Marzban: HTTP %s", response.status)
                    return False
        except Exception as exc:
            self.token = None
            self.last_auth_status = None
            self.last_auth_error = str(exc)
            logger.error("Сетевая ошибка при авторизации в Marzban: %s", exc)
            return False

    async def _request(
        self,
        method: str,
        path: str,
        *,
        json_payload: Optional[Any] = None,
        data_payload: Optional[Dict[str, Any]] = None,
        timeout: int = 20,
        retry_on_401: bool = True,
    ) -> Tuple[bool, Optional[Any], Optional[int], Optional[str]]:
        """
        Возвращает кортеж:
        (ok, payload, status_code, error_text)
        """
        if not await self._authenticate():
            code = self.last_auth_status
            if code in (401, 403):
                return False, None, code, "Ошибка авторизации в Marzban (проверьте логин/пароль)."
            return False, None, code, self.last_auth_error or "Не удалось получить токен Marzban."

        url = f"{self.base_url}{path}"
        headers = {
            "Authorization": f"Bearer {self.token}",
            "accept": "application/json",
        }

        try:
            async with aiohttp.ClientSession() as session:
                async with session.request(
                    method,
                    url,
                    headers=headers,
                    json=json_payload,
                    data=data_payload,
                    timeout=ClientTimeout(total=timeout),
                    ssl=self._ssl_option(),
                ) as response:
                    status_code = response.status

                    if status_code in (401, 403) and retry_on_401:
                        logger.warning("Токен Marzban недействителен, выполняем переавторизацию...")
                        self.token = None
                        return await self._request(
                            method,
                            path,
                            json_payload=json_payload,
                            data_payload=data_payload,
                            timeout=timeout,
                            retry_on_401=False,
                        )

                    if 200 <= status_code < 300:
                        content_type = response.headers.get("content-type", "")
                        if "application/json" in content_type:
                            return True, await response.json(), status_code, None
                        return True, {"raw": await response.text()}, status_code, None

                    return False, None, status_code, await response.text()
        except Exception as exc:
            logger.error("Сетевая ошибка Marzban API %s %s: %s", method, path, exc)
            return False, None, None, str(exc)

    async def force_reconnect(self) -> Dict[str, Any]:
        """Сброс токена и повторная проверка коннекта."""
        self.token = None
        await self._authenticate(force=True)
        return await self.get_connection_status(force_reauth=False)

    async def get_users(self) -> List[Dict[str, Any]]:
        ok, payload, _, _ = await self._request("GET", "/api/users", timeout=20)
        if not ok:
            return []

        if isinstance(payload, list):
            return payload
        if isinstance(payload, dict):
            users = payload.get("users")
            if isinstance(users, list):
                return users
        return []

    async def get_connection_status(self, force_reauth: bool = False) -> Dict[str, Any]:
        if force_reauth:
            self.token = None

        ok, payload, status_code, error_text = await self._request("GET", "/api/users", timeout=15)
        if ok:
            users = payload if isinstance(payload, list) else payload.get("users", [])
            users_count = len(users) if isinstance(users, list) else 0
            return {
                "connected": True,
                "users_count": users_count,
                "http_status": status_code or 200,
                "error_code": None,
                "error": None,
            }

        if status_code in (401, 403):
            return {
                "connected": False,
                "users_count": 0,
                "http_status": status_code,
                "error_code": f"auth_{status_code}",
                "error": f"Ошибка авторизации Marzban ({status_code}). Проверьте MARZBAN_USERNAME/MARZBAN_PASSWORD.",
            }

        if status_code:
            return {
                "connected": False,
                "users_count": 0,
                "http_status": status_code,
                "error_code": "http_error",
                "error": f"Marzban API вернул HTTP {status_code}: {error_text or 'без текста ошибки'}",
            }

        return {
            "connected": False,
            "users_count": 0,
            "http_status": None,
            "error_code": "network",
            "error": error_text or "Сетевая ошибка соединения с Marzban.",
        }

    async def add_node(self, *, name: str, address: str, port: int) -> Dict[str, Any]:
        """Добавляет ноду в Marzban Panel."""
        ok, payload, status_code, error_text = await self._request(
            "POST",
            "/api/node",
            json_payload={
                "name": name,
                "address": address,
                "port": int(port),
                "api_port": 62051,
                "usage_coefficient": 1,
                "add_as_new_host": True,
            },
            timeout=25,
        )
        if not ok:
            return {
                "ok": False,
                "status_code": status_code,
                "error": f"Не удалось добавить ноду в Marzban (HTTP {status_code}): {error_text}",
            }

        node_id = payload.get("id") if isinstance(payload, dict) else None
        return {"ok": True, "node_id": node_id, "payload": payload}

    async def remove_node(self, marzban_node_id: int) -> Dict[str, Any]:
        ok, _, status_code, error_text = await self._request(
            "DELETE",
            f"/api/node/{marzban_node_id}",
            timeout=20,
        )
        if not ok:
            return {
                "ok": False,
                "status_code": status_code,
                "error": f"Не удалось удалить ноду из Marzban (HTTP {status_code}): {error_text}",
            }
        return {"ok": True}

    async def get_hosts(self) -> Dict[str, Any]:
        ok, payload, _, _ = await self._request("GET", "/api/hosts", timeout=20)
        if not ok or not isinstance(payload, dict):
            return {}
        return payload

    async def update_hosts(self, hosts_payload: Dict[str, Any]) -> Dict[str, Any]:
        ok, payload, status_code, error_text = await self._request(
            "PUT",
            "/api/hosts",
            json_payload=hosts_payload,
            timeout=25,
        )
        if not ok:
            return {
                "ok": False,
                "status_code": status_code,
                "error": f"Не удалось обновить hosts в Marzban: {error_text}",
            }
        return {"ok": True, "payload": payload}

    async def ensure_host_in_group(
        self,
        *,
        inbound_tag: str,
        remark: str,
        address: str,
        port: int,
        sni: str,
        fingerprint: str,
    ) -> Dict[str, Any]:
        """
        Добавляет/обновляет host-запись в выбранной inbound-группе.
        """
        hosts = await self.get_hosts()
        if inbound_tag not in hosts or not isinstance(hosts.get(inbound_tag), list):
            return {
                "ok": False,
                "error": f"В Marzban не найдена inbound-группа '{inbound_tag}'.",
            }

        group = hosts[inbound_tag]
        updated = False

        for item in group:
            if not isinstance(item, dict):
                continue
            if item.get("address") == address or item.get("remark") == remark:
                item["remark"] = remark
                item["address"] = address
                item["port"] = int(port)
                item["sni"] = sni
                item["host"] = sni
                item["fingerprint"] = fingerprint
                item["security"] = item.get("security") or "tls"
                item["is_disabled"] = False
                updated = True
                break

        if not updated:
            group.append(
                {
                    "remark": remark,
                    "address": address,
                    "port": int(port),
                    "sni": sni,
                    "host": sni,
                    "path": "",
                    "security": "tls",
                    "alpn": "h2,http/1.1",
                    "fingerprint": fingerprint,
                    "allowinsecure": False,
                    "is_disabled": False,
                    "mux_enable": False,
                    "fragment_setting": "",
                }
            )

        save_result = await self.update_hosts(hosts)
        if not save_result.get("ok"):
            return save_result

        return {"ok": True, "updated": updated}

    async def remove_host_from_group(self, *, inbound_tag: str, address: str, remark: str) -> Dict[str, Any]:
        """Удаляет host-запись из inbound-группы по адресу/remark."""
        hosts = await self.get_hosts()
        if inbound_tag not in hosts or not isinstance(hosts.get(inbound_tag), list):
            return {"ok": True, "removed": False}

        group = hosts[inbound_tag]
        before = len(group)
        group[:] = [
            item
            for item in group
            if not (
                isinstance(item, dict)
                and (item.get("address") == address or item.get("remark") == remark)
            )
        ]
        removed = len(group) != before
        if not removed:
            return {"ok": True, "removed": False}

        save_result = await self.update_hosts(hosts)
        if not save_result.get("ok"):
            return save_result

        return {"ok": True, "removed": True}

    async def check_traffic_anomalies(self, bot: Bot) -> None:
        """
        Проверяет трафик пользователей. Если скачано больше порога за цикл,
        отправляет alert администратору.
        """
        logger.info("Запуск проверки аномалий трафика в Marzban...")
        users = await self.get_users()

        if not users:
            logger.warning("Не удалось получить список пользователей для проверки трафика.")
            return

        for user in users:
            username = user.get("username")
            status = user.get("status")
            used_traffic = int(user.get("used_traffic", 0) or 0)

            if not username or status != "active":
                continue

            if username in self._traffic_state:
                previous_traffic = self._traffic_state[username]
                delta = used_traffic - previous_traffic

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
                    logger.warning("Аномалия трафика у %s: %s GB", username, delta_gb)

            self._traffic_state[username] = used_traffic


marzban_manager = MarzbanManager()
