# LUFFY Control Tower: Техническая документация

## 1. Назначение
`LUFFY Control Tower` — это управляющая панель для VPN/Proxy-кластера с доступом через Telegram Mini App и Telegram-бота.

Система решает задачи:
- учет и хранение инвентаря нод (Ingress/Egress/Master);
- удаленное выполнение команд по SSH;
- безопасное обновление `haproxy.cfg` на удаленных нодах;
- мониторинг состояния инфраструктуры и уведомления в Telegram;
- интеграция с Marzban API для статистики и алертов.

## 2. Архитектура

### 2.1 Компоненты
- `FastAPI` — HTTP API (`/api/*`) и health-check (`/health`).
- `Static Mini App` (`static/index.html`) — web-интерфейс Telegram Mini App.
- `Aiogram` — Telegram-бот (long polling).
- `SQLite` (`aiosqlite`, WAL) — хранилище нод и настроек.
- `APScheduler` — фоновые SRE/security/backup задачи.
- `asyncssh` — управление удаленными нодами.
- `aiohttp` — интеграция с Marzban API.

### 2.2 Поток запуска
1. `main.py` инициализирует логирование и БД.
2. Стартует планировщик фоновых задач.
3. Параллельно запускаются два сервиса: `uvicorn` (FastAPI) и `aiogram` polling.
4. Статический Mini App отдается из `static/`, API живет под `/api`.

## 3. Структура репозитория
- `main.py` — точка входа приложения.
- `config.py` — загрузка конфигурации из `.env`.
- `web/api.py` — API Mini App + авторизация Telegram initData.
- `bot/handlers.py` — команды Telegram-бота.
- `bot/middlewares.py` — AntiFlood middleware.
- `services/ssh_manager.py` — универсальный SSH-исполнитель.
- `services/deployer.py` — автоматический bootstrap нод.
- `services/haproxy_manager.py` — безопасное применение `haproxy.cfg`.
- `services/monitor.py` — планировщик мониторинга.
- `services/marzban.py` — клиент Marzban API + детекция аномалий.
- `services/security.py` — auto-ban + SSH audit.
- `services/backup.py` — weekly backup БД с отправкой в Telegram.
- `db/database.py` — схема и доступ к SQLite (WAL).
- `docker-compose.yml`, `Dockerfile` — контейнеризация.
- `.github/workflows/deploy.yml` — CD-пайплайн.

## 4. Конфигурация

### 4.1 Ключевые переменные `.env`

| Переменная | Назначение | Пример |
|---|---|---|
| `BOT_TOKEN` | токен Telegram-бота | `123456:ABC...` |
| `ADMIN_ID` | Telegram user ID администратора | `123456789` |
| `WEB_HOST` | хост FastAPI внутри процесса | `0.0.0.0` |
| `WEB_PORT` | порт FastAPI и Docker mapping | `8085` |
| `WEB_APP_URL` | публичный HTTPS URL Mini App | `https://tower.volart.pro` |
| `SSH_DEFAULT_USER` | SSH пользователь по умолчанию | `root` |
| `SSH_KEY_PATH` | fallback-ключ на хосте | `/root/.ssh/id_rsa` |
| `SSH_PORT` | SSH порт нод | `2222` |
| `MARZBAN_URL` | URL Marzban API | `http://127.0.0.1:8000` |
| `MARZBAN_USERNAME` | логин Marzban | `admin` |
| `MARZBAN_PASSWORD` | пароль Marzban | `***` |
| `DB_PATH` | путь к SQLite (переопределяется compose) | `/app/data/luffy_cluster.db` |

### 4.2 Критичное правило портов
Значение `WEB_PORT` должно быть согласовано в трех местах:
- `.env`: `WEB_PORT`;
- `docker-compose.yml`: проброс `${WEB_PORT}:${WEB_PORT}`;
- `nginx`: `proxy_pass http://127.0.0.1:<WEB_PORT>;`.

Если порты не совпадают, получите `502 Bad Gateway`.

## 5. Модель данных

### 5.1 Таблица `nodes`
Поля:
- `id` (PK, autoincrement);
- `ip` (unique, not null);
- `role` (`master`, `ingress`, `egress`);
- `billing_date` (`YYYY-MM-DD`);
- `status` (`active`/`offline`, default `active`);
- `ssh_key` (private key ноды, может быть `NULL`).

### 5.2 Таблица `settings`
Простое key-value хранилище:
- `key` (PK);
- `value` (text).

## 6. API (Mini App)
Базовый префикс: `/api`

### 6.1 Авторизация API
Все `/api/*` endpoint защищены `require_telegram_admin`:
- требуется заголовок `X-Telegram-Init-Data`;
- подпись `initData` проверяется по HMAC-схеме Telegram;
- проверяется свежесть `auth_date` (окно 24 часа);
- `user.id` из `initData` должен совпадать с `ADMIN_ID`.

### 6.2 Endpoint-ы
- `GET /api/nodes`
  - возвращает список нод;
  - `ssh_key` не отдается наружу (заменяется флагом `has_ssh_key`).
- `POST /api/nodes`
  - добавляет ноду;
  - если `ssh_key` пуст, генерируется новый RSA private key;
  - дубликат IP вернет ошибку `400`.
- `POST /api/haproxy/apply`
  - применяет новый конфиг HAProxy на целевой ноде;
  - выполняет валидацию `haproxy -c`, backup, restart и rollback при сбое.

## 7. Telegram-бот
Доступ к командам ограничен по `ADMIN_ID`.

Команды:
- `/start` — отправляет кнопку открытия Mini App (`WEB_APP_URL`, только `https://`).
- `/nodes` — список нод из БД.
- `/sysinfo <ip>` — `uptime`, `free -m`, `df -h /` по SSH.
- `/deploy <ip> <role> <password> <billing_date>` — bootstrap новой ноды.
- `/top_users` — топ активных пользователей по трафику из Marzban.

## 8. Фоновые задачи (APScheduler)

Планировщик запускает:
- `check_disk_space` — каждые 6 часов;
- `external_port_knocker` — каждые 15 минут;
- `check_billing` — ежедневно в 10:00;
- `marzban_manager.check_traffic_anomalies` — каждый час;
- `check_decoy_watchdog` — каждые 5 минут;
- `check_ssl_expiry` — ежедневно в 09:00;
- `check_link_latency` — каждые 30 минут;
- `auto_ban_scanners` — каждые 15 минут;
- `ssh_audit` — каждые 15 минут;
- `backup_database` — воскресенье 03:00.

## 9. Развертывание

### 9.1 Docker (рекомендуется)
```bash
cp .env.example .env
# заполнить .env
docker compose up -d --build
curl -f http://127.0.0.1:${WEB_PORT:-8080}/health
```

### 9.2 Nginx reverse proxy (production)
Минимально:
```nginx
server {
    listen 80;
    server_name tower.volart.pro;
    location / {
        proxy_pass http://127.0.0.1:8085;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

После TLS (certbot) доступ к Mini App должен быть только через `https://`.

### 9.3 CD
GitHub Actions workflow `Deploy Control Tower`:
1. SSH на сервер.
2. `git pull origin main`.
3. `docker compose down && docker compose up --build -d`.
4. health-check `http://127.0.0.1:${WEB_PORT}/health`.
5. `docker image prune -f`.

## 10. Безопасность и ограничения

### 10.1 Что уже защищено
- API не обслуживает незаверенные запросы без Telegram `initData`.
- Доступ по user-level ограничен одним `ADMIN_ID`.
- `ssh_key` не показывается через API.

### 10.2 Что важно понимать
- Статическая страница Mini App может открыться у любого по URL, но API-вызовы без валидного Telegram контекста будут `401/403`.
- `ssh_key` хранится в БД в открытом виде. Это удобно для автоматизации, но требует защиты хоста и файла БД.
- В SSH-клиенте `known_hosts=None`, то есть защита от MITM снижена (осознанный компромисс).

### 10.3 Рекомендуемые усиления
- ограничить доступ к домену на уровне Nginx (`allow/deny`, basic auth, Cloudflare Access);
- шифровать `ssh_key` в БД (хотя бы symmetric encryption через master key);
- добавить аудит действий в API (кто/когда/что менял);
- добавить rate-limit на API на уровне Nginx.

## 11. Runbook: базовые операции

### 11.1 Добавление сервера через Mini App
1. Открыть Mini App только кнопкой из `/start`.
2. В форме «Добавить сервер» указать `IP`, `role`, `billing_date`.
3. Поле SSH ключа оставить пустым для автогенерации или вставить свой.
4. Нажать «Добавить сервер».

### 11.2 Применение нового `haproxy.cfg`
1. Вставить IP целевой ноды.
2. Вставить новый конфиг.
3. Нажать «Проверить и Задеплоить».
4. При синтаксической ошибке конфиг не применяется, возвращается текст ошибки.

### 11.3 Диагностика health
```bash
docker compose ps
docker compose logs --tail=200 control-tower
curl -vk https://tower.volart.pro/health
curl -H "Host: tower.volart.pro" http://127.0.0.1/health -v
```

## 12. Troubleshooting

### 12.1 `502 Bad Gateway` от Nginx
Причины:
- неверный `proxy_pass` порт;
- backend не слушает нужный `WEB_PORT`;
- container рестартует/падает.

Проверки:
- `docker compose ps`;
- `curl http://127.0.0.1:<WEB_PORT>/health`;
- `nginx -t && systemctl reload nginx`.

### 12.2 Неверный TLS сертификат на домене
Типовой кейс: порт `443` занят другим сервисом (например, `haproxy`), и клиент получает чужой сертификат.

Проверки:
- `ss -lntp | grep :443`;
- оставить владельцем `:443` только `nginx` для Mini App-домена;
- затем `certbot --nginx -d <domain>`.

### 12.3 Mini App «открывается, но не работает»
Проверьте:
- открытие строго из Telegram-бота;
- корректный `WEB_APP_URL=https://...`;
- `ADMIN_ID` совпадает с вашим Telegram user id;
- в запросах есть `X-Telegram-Init-Data`.

### 12.4 CD не может сделать `git pull`
Если сервер не ходит в `github.com:443`, deploy через Action упадет на шаге `git pull`.

Варианты:
- открыть исходящий `443` до GitHub;
- использовать зеркала/прокси;
- временно выкатывать `scp/rsync` + `docker compose up -d --build`.

## 13. Что проверить перед production
- заполнен `.env` без заглушек;
- корректны `BOT_TOKEN`, `ADMIN_ID`, `WEB_APP_URL`;
- health-check `200 OK` по HTTPS домену;
- порт `443` обслуживается нужным веб-сервером;
- backup job реально отправляет файл в Telegram;
- команды `/start`, `/nodes`, `/sysinfo` работают у администратора.
