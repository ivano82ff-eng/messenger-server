# messenger-server

Сервер мессенджера по контракту: **хранит и пересылает шифротекст**.
Тела сообщений, ключи расшифровки и имена файлов сервер **не получает и не хранит**.

Основа — `docs/server-contract.md` на `main` (коммит `bbbf3d26fabc`).
Этот README не заменяет контракт, а описывает конкретную реализацию.

## Стек

- **Node.js** 20+ (проверено на 24.x)
- **Express** 5 — HTTP
- **ws** — WebSocket
- **PostgreSQL** 14+ (проверено на 17.x)
- **jsonwebtoken** — HS256 access-токены
- **dotenv** — конфиг через `.env`

Redis нет. MinIO нет. Файлы и голосовые байты в это хранилище не кладутся.

## Требования

- Node.js >= 20
- npm >= 10
- PostgreSQL >= 14 (запущенный, с созданной БД и пользователем)
- Windows / Linux / macOS

## Быстрый старт

### 1. Установка зависимостей

```
npm install
```

### 2. Создание БД и пользователя

Под `postgres`:

```sql
CREATE USER messenger WITH PASSWORD 'messenger_dev_pass';
CREATE DATABASE messenger_db OWNER messenger;
```

### 3. Конфиг `.env`

Создай `.env` в корне проекта:

```
PORT=3000
DATABASE_URL=postgres://messenger:messenger_dev_pass@localhost:5432/messenger_db
JWT_SECRET=<длинная_случайная_строка>
ACCESS_TTL=900
REFRESH_TTL=2592000
```

`JWT_SECRET` — обязателен. 64+ случайных символов.
Быстрая генерация в PowerShell:

```powershell
-join ((1..64) | ForEach-Object { [char](Get-Random -Minimum 33 -Maximum 126) })
```

### 4. Миграции

```
npm run migrate
```

Применяет все `.sql` из `src/migrations/` по порядку.
Повторный запуск безопасен — все запросы идемпотентны (`IF NOT EXISTS`).

### 5. Запуск

```
npm start
```

Ожидаем:

```
HTTP+WS listening on http://localhost:3000
```

### 6. Проверка

```
curl http://localhost:3000/health
# {"ok":true}
```

## Скрипты

| Команда | Что делает |
|---|---|
| `npm start` | Запуск сервера |
| `npm run dev` | Запуск с автоперезапуском (nodemon) |
| `npm run migrate` | Применить миграции |
| `npm test` | Прогнать все тесты (WS + concurrency) |
| `npm run test:ws` | Только WS-тесты (10 сценариев) |
| `npm run test:concurrency` | Только параллельные тесты (3 сценария) |

Тесты бьют по `http://localhost:3000`, поэтому сервер должен быть запущен
в отдельном окне перед `npm test`.

## Переменные окружения

| Переменная | Обязательна | Значение по умолчанию | Описание |
|---|---|---|---|
| `PORT` | нет | `3000` | Порт HTTP + WS |
| `DATABASE_URL` | да | — | Строка подключения к PostgreSQL |
| `JWT_SECRET` | да | — | Секрет для HS256 access-токенов |
| `ACCESS_TTL` | нет | `900` | Время жизни access-токена, секунды |
| `REFRESH_TTL` | нет | `2592000` | Время жизни refresh-токена, секунды (30 дней) |
| `DEBUG_WS` | нет | — | `1` — включить подробные логи WebSocket |

## API

Все тела — JSON. Стек-трейсов в ответах нет.
Любой неспецифичный сбой → `400` с телом `{ "error": "..." }`.

### Коды ошибок

| Код | Когда |
|---|---|
| `400` | Невалидный запрос / неканонический `userId` / неизвестный получатель |
| `401` | Токена нет, просрочен, или уже ротирован |
| `409` | Одноразовые prekey этого пользователя кончились |

### `POST /v1/devices`

Регистрация устройства. Авторизация не нужна.
Каждый вызов создаёт нового пользователя с новым `userId`.
Повторная установка с тем же `identityPublicKey` создаёт **новый** `userId`.

Запрос:

```json
{
  "registrationId": 4821,
  "identityPublicKey": "base64...",
  "signedPreKey": {
    "keyId": 1,
    "publicKey": "base64...",
    "signature": "base64..."
  },
  "oneTimePreKeys": [
    { "keyId": 1, "publicKey": "base64..." },
    { "keyId": 2, "publicKey": "base64..." }
  ]
}
```

Ответ `201`:

```json
{
  "userId": "456 N 634",
  "deviceId": "device_1",
  "accessToken": "eyJ...",
  "refreshToken": "rfr_..."
}
```

### `POST /v1/sessions/refresh`

Ротация refresh-токена. Bearer не нужен — секрет в теле.

Запрос:

```json
{ "refreshToken": "rfr_7b1c9e" }
```

Ответ `200`:

```json
{
  "accessToken": "eyJ...",
  "refreshToken": "rfr_a02d44"
}
```

Порядок строгий: найти по хешу → проверить срок → удалить старую запись →
записать хеш нового refresh → отдать пару. Повтор старого секрета → `401`.

### `PUT /v1/keys/one-time`

Пополнить пул prekey текущего пользователя. Bearer обязателен.

Запрос:

```json
{
  "oneTimePreKeys": [
    { "keyId": 3, "publicKey": "base64..." }
  ]
}
```

Ответ `200`:

```json
{ "stored": 1 }
```

Upsert по `(user_id, key_id)`. `publicKey` можно заменить.
**`used_at` этим upsert не сбрасывается.**

### `GET /v1/keys/bundle/{userId}`

Выдать бандл, чтобы начать сессию. Bearer обязателен.
`{userId}` — канонический вид, пробелы как `%20`.

Пример: `GET /v1/keys/bundle/456%20N%20634`

Ответ `200`:

```json
{
  "userId": "781 K 209",
  "deviceId": "device_1",
  "registrationId": 1904,
  "identityPublicKey": "base64...",
  "signedPreKey": {
    "keyId": 1,
    "publicKey": "base64...",
    "signature": "base64..."
  },
  "oneTimePreKey": {
    "keyId": 3,
    "publicKey": "base64..."
  }
}
```

Один свободный ключ забирается через `FOR UPDATE SKIP LOCKED` —
параллельные запросы не получат один и тот же ключ.

Пул пуст → `409` с `{ "error": "one-time prekeys exhausted" }`.

Успешный бандл **не доказывает**, что собеседник тот, за кого себя выдаёт.
Пока люди сами не сверят контрольное число, сервер может подменить бандл.

## WebSocket `/v1/ws`

Переход с `GET`. Токен в query string **не принимается**.

Два способа аутентификации:

1. Заголовок `Authorization: Bearer <accessToken>` на запросе перехода.
2. Первый текстовый кадр, и до него других кадров нет:

```json
{ "type": "auth", "accessToken": "eyJ..." }
```

Правила:

- Если заголовок был и он плох → `401` на переходе, сокета нет.
- Если заголовок валиден → сокет авторизован сразу, кадр `auth` не нужен.
- Если заголовка нет → сокет открывается, первый кадр обязан быть `auth`.
  Таймаут 10 секунд. Если не пришёл или плохой — один кадр ошибки и закрытие
  с кодом `4001`:

```json
{ "type": "error", "status": 401, "error": "invalid access token" }
```

### Клиент → сервер

```json
{
  "type": "envelope",
  "id": "env_01j8",
  "recipientUserId": "781 K 209",
  "ciphertext": "base64...",
  "sentAt": "2026-09-27T18:04:11.000Z"
}
```

`ciphertext` — непрозрачные байты в base64. Полей `body`, `text`, `plaintext`,
`filename`, `kind` нет и добавлять нельзя — тип сообщения сервер не различает.

`senderUserId` из кадра не читается — отправитель берётся из сессии по access-токену.

`recipientUserId` канонизируется. Чужой формат или неизвестный получатель →
кадр ошибки со статусом `400`, без `ack`.

### Сервер → клиент

`ack` (после commit в БД, не после доставки получателю):

```json
{ "type": "ack", "id": "env_01j8" }
```

`envelope` получателю:

```json
{
  "type": "envelope",
  "id": "env_01j8",
  "senderUserId": "456 N 634",
  "recipientUserId": "781 K 209",
  "ciphertext": "base64...",
  "sentAt": "2026-09-27T18:04:11.000Z"
}
```

`error`:

```json
{ "type": "error", "status": 400, "error": "..." }
```

### Доставка

- Повтор того же `id` от того же отправителя вторую строку не создаёт.
  `ack` всё равно уходит — строка уже зафиксирована.
- Получатель онлайн → кадр уходит после commit.
- Получатель офлайн → конверт ждёт и уходит при следующем входе,
  по возрастанию `received_at` (не `sentAt`).
- Из очереди конверт убирается после записи кадра в сокет получателя
  (`delivered_at = now()`).

## Формат `userId`

Шесть цифр и одна латинская буква: три цифры, пробел, буква, пробел, три цифры.

```
456 N 634
```

Канонический вид: `^[0-9]{3} [A-Z] [0-9]{3}$`. Буква — заглавная латиница `A–Z`.

Перед поиском: обрезать края, схлопнуть подряд идущие пробелы в один,
букву перевести в верхний регистр. `456  n   634` → `456 N 634`.

Строка без пробелов (`456N634`) и с нелатинской буквой каноном не являются — `400`.

## Токены

- **accessToken** — JWT HS256. Живёт 15 минут. Поля `sub = userId`, `exp`.
  В БД не хранится.
- **refreshToken** — случайный непрозрачный секрет формата `rfr_<64 hex>`.
  Живёт 30 дней. В БД лежит только SHA-256 от строки токена.

## Структура проекта

```
messenger-server/
├── .env                       # конфиг (не в git)
├── .gitignore
├── package.json
├── README.md
├── src/
│   ├── index.js               # точка входа: HTTP + WS на одном порту
│   ├── db/
│   │   ├── pool.js            # пул pg
│   │   └── migrate.js         # раннер миграций
│   ├── migrations/
│   │   ├── 001_init.sql       # devices, one_time_prekeys, refresh_tokens, envelopes
│   │   └── 002_envelopes_route.sql
│   ├── lib/
│   │   ├── userId.js          # канонизация и генерация userId
│   │   ├── tokens.js          # JWT + refresh-хеши
│   │   ├── auth.js            # middleware requireAuth
│   │   ├── errors.js          # формат ошибок
│   │   └── log.js             # wsLog/wsError с гейтом DEBUG_WS
│   ├── routes/
│   │   ├── devices.js         # POST /v1/devices
│   │   ├── sessions.js        # POST /v1/sessions/refresh
│   │   └── keys.js            # PUT /v1/keys/one-time, GET /v1/keys/bundle/{userId}
│   └── ws/
│       ├── hub.js             # Map<userId, Set<ws>> + withUserLock
│       └── index.js           # WS-сервер /v1/ws
└── tests/
    ├── ws.test.js             # 10 сценариев
    └── concurrency.test.js    # 3 сценария под нагрузкой
```

## Тесты

Все тесты ходят по `http://localhost:3000`, поэтому сначала запусти сервер:

```
npm start
```

Затем в другом окне:

```
npm test
```

Ожидаем в конце `ALL TESTS DONE` и `ALL CONCURRENCY TESTS PASSED`.

Что проверяют тесты:

**`tests/ws.test.js`** — 10 сценариев:
плохой/хороший Bearer на upgrade, `auth` первым кадром, таймаут auth,
доставка онлайн и офлайн, очередь по `received_at`, дедупликация по `id`,
неканонический `recipientUserId`, неизвестный получатель.

**`tests/concurrency.test.js`** — 3 сценария:
параллельный `GET bundle` (5 запросов → 5 разных ключей),
параллельный `refresh` (один 200, второй 401),
параллельный `envelope` с одним `id` (одна строка в БД, один кадр у B).

## Прод

Это версия для локальной разработки. Перед выкладкой в прод нужно:

- **TLS** — Caddy или nginx как reverse-proxy. Caddy проще:
  сертификат Let's Encrypt автоматически, WebSocket upgrade из коробки.
- **Автозапуск** — PM2 или nssm (Windows) / systemd (Linux).
  Пример для PM2:
  ```
  npm install -g pm2 pm2-windows-startup
  pm2 start src/index.js --name messenger
  pm2 save
  pm2-startup install
  ```
- **Секреты** — `JWT_SECRET` и пароль БД не в репозиторий, только в `.env`
  или переменные окружения.
- **Резервные копии БД** — регулярный `pg_dump` в отдельное место.
- **Мониторинг** — `/health` сейчас всегда `{ok:true}`;
  можно расширить проверкой `SELECT 1` в БД.
- **Rate limiting** — на `POST /v1/devices` и `POST /v1/sessions/refresh`.

## Что сервер **не** делает

Явно, по контракту:

- Не расшифровывает `ciphertext`.
- Не хранит ключи сообщений.
- Не разбирает содержимое `signedPreKey` и `oneTimePreKeys` — хранит как непрозрачные.
- Не различает тип сообщения (`text` / `file` / `voice`) — поля `kind` нет.
- Не хранит тела сообщений, имена файлов, голосовые байты.
- Не проверяет, что собеседник — тот, за кого себя выдаёт (сверка контрольного числа — на клиенте).

## Лицензия

ISC
