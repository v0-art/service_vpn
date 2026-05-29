# LUFFY Control Tower: Model Handoff

Этот файл предназначен для будущих AI-агентов и разработчиков, которые продолжают
работу над проектом. Он накопительный: верхние разделы отражают актуальное
состояние и должны обновляться после каждой сессии, а журнал ниже нужно
дополнять новыми записями без удаления полезного контекста.

## Актуальная стадия
Дата последнего обновления: 2026-05-29.

Приложение сейчас работает как Telegram Mini App с FastAPI backend, SQLite,
Telegram-ботом, базовой интеграцией Marzban, ручным применением HAProxy и
периодическими SRE/security checks. Первый фундаментальный этап уже внедрен:
новая модель ролей/inbound, encrypted credentials, полный импорт Marzban и
выборочная форма импорта существующей Marzban Node.

В коде уже есть новые таблицы для ролей и inbound-привязок, SSH credentials
key/password, шифрование секретов, Marzban full import/sync endpoint,
минимальная UI-кнопка полного импорта и форма выбора одной Marzban Node с
добавлением SSH key/password. Следующая цель: перевести старые формы на
roles/inbound editor или перейти к метрикам и авто-реакциям.

## Что сейчас работает
- Telegram Mini App открывается из бота и использует Telegram `initData` для API.
- Внешний браузер видит клиентскую заглушку 404; API без Telegram `initData`
  не принимает запросы.
- Есть таблица `nodes` с базовыми полями сервера, одним `inbound_tag`,
  `group_sni`, `fingerprint`, SSH key и Marzban status.
- Добавлены таблицы `node_roles` и `node_inbounds` для новой модели
  нескольких ролей/inbound на один сервер.
- Добавлены поля `ssh_username`, `ssh_password`, `credential_status` и
  Marzban metadata columns в `nodes`.
- Добавлен `SecretManager`: новые SSH key/password шифруются при наличии
  `MASTER_SECRET_KEY`; без него сохраняется совместимость с plaintext.
- При наличии `MASTER_SECRET_KEY` старые plaintext SSH key/password
  дозашифровываются во время `init_db`.
- SSH executor теперь читает per-node username, key и password, пробует key и
  fallback password.
- Добавлен Marzban import/sync: `POST /api/marzban/import`.
- Добавлен импорт одной выбранной Marzban Node: `POST /api/marzban/import/node`.
- `GET /api/nodes` теперь возвращает `roles`, `inbounds`, credential flags и
  Marzban metadata без раскрытия секретов.
- Добавлен `PUT /api/nodes/{node_id}/credentials`.
- Frontend source получил кнопку "Импорт Marzban", credential labels и
  модальный confirm для импорта/удаления.
- Форма "Существующий сервер" теперь читает `GET /api/marzban/nodes`, дает
  выбрать Marzban Node, показывает найденные inbound hosts по IP и отправляет
  SSH username/key/password в single-node import endpoint.
- В Mini App есть вкладка `Мониторинг` со сводкой по серверам, SSH, Marzban и
  состоянию нод.
- Инвентарь показывает все inbound-привязки сервера, а не только количество.
- Верхние счетчики берут локальный инвентарь как fallback, поэтому список
  серверов не отображается как пустой при ошибке/задержке overview.
- SSH audit фильтрует рутинные входы с текущего Control Tower source IP,
  master/trusted IP и не повторяет уже отправленные события в рамках процесса.
- Port Knocker больше не редактирует HAProxy автоматически; после 3 подряд
  неуспешных проверок он меняет статус в панели и отправляет alert.
- SSH overview проверяет ноды через per-node credentials или через доступный
  fallback key из `/root/.ssh`, поэтому общий примонтированный ключ учитывается
  в счетчике SSH.
- Можно вручную добавить сервер в инвентарь.
- Можно редактировать параметры сервера в текущей старой модели.
- Можно удалить сервер с попыткой удаления из Marzban и cleanup по SSH.
- Есть Marzban auth, `/api/users`, `/api/hosts`, `POST /api/node`,
  `DELETE /api/node/{id}` и обновление hosts через текущий клиент.
- Есть ручное применение HAProxy config: временный файл, `haproxy -c`, backup
  `.bak`, restart и rollback при падении сервиса.
- Есть фоновые проверки диска, billing date, SSH audit, UFW scanner ban,
  decoy watchdog, SSL expiry, latency и грубые traffic anomalies.
- `python3 -m compileall .` проходит успешно.

## Что пока не работает или не реализовано
- Старые формы добавления/редактирования еще не полностью переведены на новую
  модель ролей-чекбоксов и отдельное редактирование inbound.
- Все ручные мутации еще не переведены на модальные подтверждения; уже сделаны
  полный импорт Marzban и удаление. Новая single-node import форма пока
  отправляет изменение напрямую после submit.
- Новый node deploy не реализует финальный официальный интерактивный сценарий
  Marzban Node installer с сертификатом.
- HAProxy templates по ролям и история версий еще не вынесены в панель.
- Метрики по серверам, пользователям, трафику и ЧНН за 14 дней еще не
  реализованы.
- Автоотключение/автовосстановление host в Marzban еще не реализовано.
- Master `xray.json` automation пока намеренно не делается.
- Runtime-проверка FastAPI server/bot целиком не выполнена: для нее нужен
  валидный Telegram/Marzban runtime и реальные env-секреты.
- Реальный Marzban import/sync и real SSH key/password connection не проверены
  на живой инфраструктуре.

## Принятые продуктовые решения
- Marzban Nodes являются источником правды для существующих серверов.
- Первый импорт должен импортировать все Marzban Nodes, сопоставлять их со
  старой БД по IP и не создавать дубликаты.
- К каждой ноде нужно подтягивать все `hosts` из Marzban по `host.address == node.ip`.
- Если IP есть в Marzban hosts, но отсутствует в Marzban Nodes, это считается
  ошибкой консистентности. Такой сервер не импортируется как рабочая нода,
  потому что без Marzban Node он не должен работать.
- Для существующей ноды пользователь выбирает ноду из Marzban, LUFFY подтягивает
  все данные, затем админ добавляет SSH key или password.
- Для нового сервера имя вводит пользователь.
- Сервер может иметь несколько ролей-чекбоксов:
  `master`, `direct_ru`, `direct_eu`, `transit_sender`,
  `transit_receiver`, `warp`.
- Старые `ingress`/`egress`/`master` нужно мигрировать мягко в новую модель
  ролей/возможностей.
- Маппинг inbound в роли:
  `IN-RU-DIRECT -> direct_ru`,
  `IN-EU-DIRECT -> direct_eu`,
  `IN-TRANSIT-GB/IN-TRANSIT-NO -> transit_sender`,
  `IN-EU-TRANSIT-RECV -> transit_receiver`,
  `IN-EU-DIRECT-WARP -> warp`.
- У каждого сервера может быть несколько inbound. В самих inbound обычно
  различаются только SNI и название, но при sync нужно доверять Marzban и
  сохранять фактические значения.
- SSH credentials должны поддерживать `ssh_username`, `ssh_key`,
  `ssh_password`. Порядок попыток: key, затем password.
- Если вход успешен по password, пароль остается основным способом доступа;
  LUFFY не обязан автоматически навязывать свой SSH key.
- Секреты можно хранить в БД, но нужно добавить шифрование через
  `MASTER_SECRET_KEY` в `.env`.
- Master существует для БД, Marzban/API и HAProxy подписок; пользовательский
  трафик через него не идет.
- Внешний браузер пока оставляем как есть: клиентская 404-заглушка плюс
  защищенный API. Tokenized вход на `/` пока не нужен.

## New Node Deploy: целевой сценарий
Для новой ноды нужно автоматизировать официальный Marzban Node installer:

1. В Marzban создать Node с именем, IP и портом `62050`.
2. Получить Client Certificate из Marzban.
3. Подключиться к новой VPS по SSH key или password, которые админ ввел в панель.
4. Установить базовые пакеты: `curl`, `ufw`, `haproxy` и нужные утилиты.
5. Настроить SSH port `2222`, UFW allowlist и нужные порты.
6. Запустить официальный скрипт:
   `bash -c "$(curl -sL https://github.com/Gozargah/Marzban-scripts/raw/master/marzban-node.sh)" @ install`
7. На prompt `Please paste the content of the Client Certificate...` вставить
   сертификат и завершить ввод пустой строкой.
8. На вопрос REST protocol ответить `Y`.
9. На `SERVICE_PORT` и `XRAY_API_PORT` оставить значения по умолчанию.
10. Проверить, что нода стала `Connected` в Marzban.

Важно: на нодах нет локального xray config, они получают общий config с мастера.
Не пытаться править локальный xray config на нодах.

## HAProxy
- HAProxy auto-edit запрещен.
- Применение HAProxy только вручную через UI с модальным подтверждением.
- Нужны редактируемые HAProxy-шаблоны в панели.
- Шаблоны должны быть по ролям, а не по конкретным серверам.
- Для каждой роли нужен один активный шаблон плюс история версий/backup.
- UFW allowlist, trusted transit IPs, ports и default SSH port должны
  редактироваться в панели.
- Master `xray.json` для транзитных узлов в будущем нужно менять с
  backup/validate/restart, но сейчас эту часть не автоматизировать.
- Если когда-нибудь автоматизировать master config, валидировать через
  `xray run -test -config <file>`.

## Метрики и ЧНН
- Нужна отдельная вкладка метрик.
- Хранить только агрегаты, без клиентских IP/UUID.
- История хранится 14 дней кольцом: приходит 15-й день, первый день удаляется.
- ЧНН означает час наибольшей нагрузки.
- ЧНН считать по каждому серверу отдельно.
- Хранить оба показателя: пик трафика за час и пик онлайн/активности за час.
- Основной источник: Marzban API.
- Дополнительный источник: SSH/docker/journal/system metrics на нодах.
- Если на нодах не хватает логирования для агрегатов, LUFFY может подготовить
  нужный сбор метрик. Для новых нод это можно делать в deploy flow, для
  существующих нужна кнопка "подготовить метрики" с подтверждением.
- Так как локального xray config на нодах нет, подготовка метрик не должна
  предполагать правку local xray config.

## Автоматические реакции
- Для автодействий подтверждение не требуется, но нужны запись в лог и сообщение админу.
- Проверка аварии: 3 подряд неуспешных проверки с интервалом примерно 30-60 секунд.
- Условия аварии:
  - Marzban node disconnected/error;
  - SSH недоступен;
  - inbound port не отвечает;
  - `marzban-node`/`xray`/docker service не работает.
- Если несколько условий говорят, что нода реально мертвая, LUFFY должен:
  - отключить все host-записи этого IP во всех inbound в Marzban;
  - выставить `is_disabled=true`;
  - дописать к имени host маркер ` [ИДУТ РАБОТЫ]`;
  - не менять SNI/port;
  - поменять статус в панели;
  - отправить сообщение админу.
- Нужно хранить оригинальные host names/remarks, чтобы recovery точно убрал
  только свой маркер.
- Recovery action автоматический: если нода восстановилась, LUFFY включает host
  обратно, убирает ` [ИДУТ РАБОТЫ]`, обновляет статус и пишет админу.
- Разрешенные soft-heal действия:
  - restart `marzban-node`;
  - restart `xray`;
  - docker compose restart/down-up для marzban-node;
  - `ufw reload` или осторожная проверка UFW;
  - уведомление админу.
- HAProxy автоматически не редактировать.

## UI и подтверждения
- Все ручные мутации должны идти через нормальные модальные подтверждения, не
  через `window.confirm`.
- Подтверждать: добавление, редактирование, удаление, отключение host, рестарт
  сервиса, применение HAProxy, подготовку метрик, изменение шаблонов.
- При редактировании inbound нужны только поля: название, IP, порт, SNI,
  fingerprint.
- Для существующей ноды форма добавления должна требовать минимум: выбрать
  ноду из Marzban и добавить SSH key/password, если нужно.

## Рекомендуемый порядок реализации
1. Новая модель БД и безопасная миграция без удаления старых данных. Done in
   first pass; runtime DB validation OK in pass 2.
2. Marzban full sync/import всех Nodes и Hosts. First pass done, needs real
   Marzban API test.
3. Credentials: `ssh_username`, encrypted `ssh_key`, encrypted `ssh_password`,
   статус "требуется SSH доступ". First pass done, needs runtime SSH test.
4. Новая форма добавления существующей ноды из Marzban. Done in implementation
   pass 2, needs real Marzban API test.
5. Метрики и 14-дневная история. Pending.
6. Авто-реакции disable/recover host в Marzban. Pending.
7. HAProxy templates в панели с версиями/backup. Pending.
8. Новый node deploy через официальный installer. Pending.

Порядок не критичен для пользователя, потому что приложение сейчас не
используется в боевом процессе, но код все равно нужно менять мягко и
сохранять текущие рабочие сценарии.

## Проверки, проведенные в последней сессии
- Просмотрены основные файлы backend/frontend:
  `web/api.py`, `services/marzban.py`, `services/deployer.py`,
  `services/haproxy_manager.py`, `services/monitor.py`,
  `services/ssh_manager.py`, `db/database.py`, `frontend/src/App.tsx`,
  `frontend/src/api.ts`, `frontend/src/types.ts`.
- Проверена официальная документация Marzban: она направляет к Swagger `/docs`
  при `DOCS=True`.
- Сверены официальные исходники Marzban по node/host API:
  `https://raw.githubusercontent.com/Gozargah/Marzban/master/app/routers/node.py`
  и
  `https://raw.githubusercontent.com/Gozargah/Marzban/master/app/models/proxy.py`.
- `python3 -m py_compile config.py db/database.py services/secrets.py
  services/ssh_manager.py services/marzban.py services/marzban_sync.py
  services/deployer.py web/api.py` прошел успешно.
- `python3 -m compileall .` прошел успешно.
- `git diff --check` прошел успешно.
- `npm ci`, `npm run lint` и `npm run build` прошли успешно; свежий build
  скопирован из `frontend/dist` в `static`.
- Runtime DB init проверен в `/tmp/luffy-venv` на временной SQLite базе:
  `runtime db init ok`.
- `web.api` импортирован в `/tmp/luffy-venv`: `api import ok: 15 routes`.
- Полный FastAPI/bot runtime, real Marzban import и real SSH connection не
  проверялись, потому что требуют реальные env-секреты и инфраструктуру.

## Журнал сессий

### 2026-05-28, Codex/GPT-5
- Проведена ревизия текущей архитектуры без изменения поведения приложения.
- Зафиксировано, что существующий режим добавления сервера не читает Marzban, а
  просто создает локальную запись.
- Зафиксировано ограничение старой схемы: один сервер хранит только один
  `inbound_tag`, хотя целевая модель требует несколько inbound/ролей.
- Согласовано, что Marzban Nodes являются источником правды, а LUFFY должен
  импортировать все ноды сразу.
- Согласована новая модель ролей-чекбоксов.
- Согласованы SSH key/password credentials, отдельный `ssh_username` и
  шифрование секретов через `MASTER_SECRET_KEY`.
- Согласован автоматический disable/recovery host в Marzban с маркером
  ` [ИДУТ РАБОТЫ]`.
- Согласовано, что HAProxy не редактируется автоматически, а шаблоны по ролям
  будут редактироваться в панели.
- Согласованы метрики: агрегаты, 14-дневное кольцо, ЧНН по каждому серверу по
  трафику и онлайн/активности.
- Добавлен этот handoff-файл и обновлен человеческий README.

### 2026-05-28, Codex/GPT-5, implementation pass 1
- Добавлен `MASTER_SECRET_KEY` в config и `.env.example`.
- Добавлен `services/secrets.py` с Fernet encryption wrapper и plaintext
  fallback для совместимости.
- `init_db` теперь пытается дозашифровать старые plaintext credentials, если
  `MASTER_SECRET_KEY` задан.
- Добавлен explicit dependency `cryptography>=42.0.0`.
- Расширена БД:
  `node_roles`,
  `node_inbounds`,
  `ssh_username`,
  `ssh_password`,
  `credential_status`,
  Marzban metadata columns,
  `last_marzban_sync`.
- `SSHManager` теперь использует per-node username/key/password и fallback
  password.
- `MarzbanManager` получил методы `get_nodes`, `get_node_settings`,
  `get_nodes_usage`.
- Добавлен `services/marzban_sync.py`:
  imports all Marzban Nodes,
  matches hosts by `address == node.ip`,
  fills roles via inbound map,
  reports unmatched hosts without importing them as working nodes.
- `GET /api/nodes` теперь отдает новые поля `roles`, `inbounds`,
  `has_ssh_password`, `has_credentials`, `credential_status`, Marzban metadata.
- `POST /api/marzban/import` добавлен для полного sync/import.
- `PUT /api/nodes/{node_id}/credentials` добавлен для обновления SSH доступа.
- Старый `POST /api/nodes` и `PUT /api/nodes/{id}` начали писать single
  role/inbound в новые таблицы для совместимости.
- `DELETE /api/nodes/{id}` теперь пытается удалить все локально известные
  inbound host bindings, а не только legacy `inbound_tag`.
- `GET /api/status/overview` не делает SSH check для нод без configured
  credentials.
- Frontend source:
  добавлена кнопка "Импорт Marzban",
  добавлен ConfirmDialog,
  удаление переведено с `window.confirm` на modal,
  inventory показывает roles/inbound count и key/password credential label,
  add/edit forms принимают `ssh_username` и `ssh_password`.
- Проверки:
  `py_compile` OK,
  `compileall` OK,
  `git diff --check` OK.
- Не проверено:
  frontend typecheck/build,
  runtime DB init,
  real Marzban import,
  real SSH key/password connection,
  потому что окружение не содержит runtime deps, node/npm, pip/venv или docker.

### 2026-05-28, Codex/GPT-5, implementation pass 2
- Добавлен `sync_single_marzban_node` в `services/marzban_sync.py`.
- Добавлен endpoint `POST /api/marzban/import/node`:
  принимает `marzban_node_id` или `address`, `ssh_username`, `ssh_port`,
  `ssh_key`, `ssh_password`, optional `billing_date`;
  импортирует выбранную Marzban Node, матчингует все hosts по
  `host.address == node.address`, обновляет `node_roles`/`node_inbounds` и
  сохраняет encrypted credentials.
- Frontend API получил `fetchMarzbanNodes` и `importMarzbanNode`.
- Форма "Существующий сервер" больше не требует ручного IP/inbound: она
  загружает Marzban Nodes, позволяет выбрать одну Node, показывает найденные
  inbound hosts и требует SSH key или password перед импортом.
- Выполнен `npm ci`; зависимости установлены в `frontend/node_modules`.
- Выполнены проверки:
  `python3 -m py_compile ...` OK,
  `python3 -m compileall .` OK,
  `git diff --check` OK,
  `npm run lint` OK,
  `npm run build` OK,
  runtime `init_db` на временной SQLite базе OK,
  `web.api` import OK.
- Fresh frontend build скопирован в `static/`.
- Не проверено на реальной инфраструктуре:
  live Marzban `/api/nodes` + `/api/hosts`,
  single-node import against real Marzban,
  SSH login по key/password,
  full FastAPI/bot process with real env.

### 2026-05-29, Codex/GPT-5, bugfix pass
- Исправлен расчет `/api/status/overview`: SSH denominator теперь отражает все
  активные ноды, включая ноды без credentials, а не только реально проверенные
  SSH-подключения.
- Верхняя панель Mini App теперь показывает количество серверов из локального
  инвентаря как fallback, чтобы при сбое overview не было `Серверы 0`.
- Добавлена вкладка `Мониторинг` с карточками состояния и таблицей нод.
- Инвентарь на desktop/mobile раскрывает все inbound host bindings с SNI/port.
- `services/security.py:ssh_audit` фильтрует рутинные successful logins с
  текущего Control Tower source IP, master-нод и IP из
  `SSH_AUDIT_TRUSTED_IPS`, а также дедуплицирует события.
- `services/monitor.py:external_port_knocker` больше не выполняет `sed` по
  `haproxy.cfg` и `systemctl reload haproxy`; автоматическая реакция ограничена
  статусом панели и alert после 3 подряд неуспешных проверок.
- `services/ssh_manager.py` теперь ищет доступные fallback keys
  (`SSH_KEY_PATH`, `id_ed25519`, `id_rsa`, `id_ecdsa`), а `/status/overview`
  не пропускает ноды с `credential_status=missing`, если fallback key доступен.
- Добавлена настройка `SSH_AUDIT_TRUSTED_IPS` в `config.py` и `.env.example`.
- Проверки: `py_compile`, `compileall`, `npm run lint`, `npm run build`,
  `git diff --check`; свежий build синхронизирован в `static/`.
