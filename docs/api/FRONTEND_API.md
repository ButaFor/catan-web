# Frontend API contract

Цей документ описує поточний transport-контракт між frontend і server:
authentication, HTTP rooms і Socket.IO room flows. Game API ще не реалізований
і позначений як planned.

Статуси:

- **Implemented** — доступно в поточній реалізації.
- **Planned** — погоджено архітектурно, але ще не можна використовувати.
- **Experimental** — доступно, але контракт може змінитися до завершення MVP.

## 1. Environments and base URL

Локальний server типовo слухає `http://127.0.0.1:3000`. Socket.IO
підключається до того самого origin через `/socket.io`.

```ts
const socket = io("http://127.0.0.1:3000", {
  withCredentials: true,
});
```

Session зберігається в `HttpOnly` cookie `catan_session`. Frontend не повинен
читати або зберігати session token самостійно.

## 2. Common errors

HTTP errors мають форму:

```json
{
  "code": "INVALID_REQUEST",
  "message": "Request data is invalid"
}
```

Для UX-логіки використовуйте `code`, а не текст `message`.

| HTTP | Code | Значення |
|---:|---|---|
| 400 | `INVALID_REQUEST` | body, params або query не пройшли validation |
| 401 | `AUTHENTICATION_REQUIRED` | немає valid session |
| 401 | `INVALID_CREDENTIALS` | неправильні credentials |
| 403 | `FORBIDDEN` | немає permission |
| 404 | `NOT_FOUND` | ресурс не знайдений |
| 409 | `ROOM_FULL` | кімната заповнена |
| 409 | `INVALID_STATE_TRANSITION` | операція несумісна з lifecycle |
| 409 | `CONCURRENCY_CONFLICT` | ресурс змінився; потрібно перечитати |
| 409 | `USERNAME_TAKEN` | username уже використовується |
| 503 | `DATABASE_UNAVAILABLE` | database тимчасово недоступна |

## 3. Authentication — Implemented

### Guest

```http
POST /auth/guest
Content-Type: application/json
```

Body — `{}` або порожній body. Відповідь `201` — public user object; server
встановлює `catan_session`.

### Register

```http
POST /auth/register
Content-Type: application/json
```

```json
{
  "username": "player_one",
  "password": "at-least-8-characters"
}
```

Username має 3–30 символів і може містити ASCII letters, digits та `_`.
Password має 8–128 символів.

### Login

```http
POST /auth/login
Content-Type: application/json
```

Body має таку саму форму, як register. Успішний login встановлює cookie.

### Current user

```http
GET /auth/me
```

Потребує session cookie. Відповідь:

```json
{
  "id": "uuid",
  "displayName": "Guest player",
  "isGuest": true,
  "createdAt": "2026-01-01T00:00:00.000Z"
}
```

Для registered/OAuth user також можуть бути `username`, `email`, `avatarUrl`.

### Logout

```http
POST /auth/logout
```

Revokes session, очищає cookie і повертає `204 No Content`.

### Google OAuth

```http
GET /auth/google
GET /auth/google/callback
```

Це browser redirect flow. Frontend направляє browser на `/auth/google`; після
callback server встановлює session cookie.

## 4. HTTP rooms API — Implemented

Усі room endpoints потребують session cookie.

### Room DTO

```json
{
  "id": "uuid",
  "code": "A1B2C3",
  "name": "Friday game",
  "hostUserId": "uuid",
  "status": "waiting",
  "capacity": 4,
  "version": 1,
  "currentRules": {
    "rulesVersion": 1,
    "rules": {}
  },
  "createdAt": "2026-01-01T00:00:00.000Z",
  "members": [
    {
      "roomId": "uuid",
      "userId": "uuid",
      "ready": false,
      "joinedAt": "2026-01-01T00:00:00.000Z"
    }
  ]
}
```

`status` зараз може бути `waiting`, `active` або `closed`.

### Create

```http
POST /rooms
Content-Type: application/json
```

```json
{ "name": "Friday game", "capacity": 4 }
```

`name` — 1–50 символів, `capacity` — integer від 3 до 4. Creator стає host
і першим member. Відповідь — `201` з Room DTO.

### Get

```http
GET /rooms/:roomId
```

Повертає актуальний Room DTO. `roomId` — UUID.

### Join

```http
POST /rooms/:roomId/join
```

Додає authenticated user до waiting room. Повторний join idempotent.

### Leave

```http
POST /rooms/:roomId/leave
```

Повертає `204`. Host спочатку має передати host role іншому member.

### Ready

```http
POST /rooms/:roomId/ready
Content-Type: application/json
```

```json
{ "ready": true }
```

Відповідь — оновлений Room DTO. User має бути member-ом.

### Update rules

```http
PUT /rooms/:roomId/rules
Content-Type: application/json
```

```json
{
  "expectedVersion": 3,
  "rulesVersion": 1,
  "rules": {}
}
```

Доступно лише host у `waiting` room. `expectedVersion` захищає від stale
updates. Після зміни rules усі members стають not ready. Поточна server-side
schema підтримує лише version `1` з порожнім object; реальні Catan rules
з’являться разом із game contracts.

### Transfer host

```http
POST /rooms/:roomId/host
Content-Type: application/json
```

```json
{ "nextHostUserId": "uuid" }
```

Доступно лише поточному host у `waiting` room. New host повинен бути member-ом.

### Close

```http
POST /rooms/:roomId/close
```

Доступно лише host у `waiting` room. Повертає `204`; після цього room не можна
join/update/ready.

## 5. Socket.IO room API — Experimental

### Connection authentication

Handshake використовує ту саму `catan_session` cookie. Без valid session
connection відхиляється з Error message `AUTHENTICATION_REQUIRED`.

```ts
const socket = io(baseUrl, { withCredentials: true });
socket.on("connect_error", (error) => {
  if (error.message === "AUTHENTICATION_REQUIRED") {
    // Повторити auth flow або направити user на login.
  }
});
```

Authentication не дає автоматичного доступу до room. User має успішно
виконати `room:join` для конкретної кімнати.

### Acknowledgements

Успішний event:

```json
{ "ok": true, "data": {} }
```

Помилка event:

```json
{
  "ok": false,
  "code": "ROOM_FULL",
  "message": "Room capacity has been reached"
}
```

Поточна implementation також може повертати `code` і `message` без `ok:false`
для помилок handler-а; frontend повинен орієнтуватися на `code`.

### Join, leave and ready

```ts
socket.emit("room:join", { roomId }, (response) => {});
socket.emit("room:leave", { roomId }, (response) => {});
socket.emit("room:ready", { roomId, ready: true }, (response) => {});
```

Payload validation:

- `roomId` — UUID;
- `ready` — boolean.

Socket приєднується до transport room лише після успішної application
authorization. Успішний join і ready broadcast-ять `room:updated`.

```ts
socket.on("room:updated", (room) => {
  // Замінити local room projection отриманим DTO.
});
```

Socket.IO rooms не є source of truth. Після reconnect frontend має повторно
отримати Room DTO через `GET /rooms/:roomId`.

Realtime events для rules update, host transfer, close та games будуть додані
після завершення відповідних handlers.

## 6. Rate limiting

Auth endpoints мають in-memory fixed-window rate limit. При перевищенні server
повертає `429` та headers `Retry-After`, `X-RateLimit-Limit`,
`X-RateLimit-Remaining`. Не робіть безперервні автоматичні retries.

## 7. Reconnection and stale state

Frontend повинен:

1. вважати HTTP response authoritative після mutation;
2. використовувати `version` для виявлення stale room projections;
3. при `CONCURRENCY_CONFLICT` перечитати room і запропонувати retry;
4. після Socket.IO reconnect перечитати поточний room;
5. не вважати socket connection доказом room membership;
6. не передавати session token у event payloads.

## 8. Games API — Planned

Game API з’явиться після додавання contracts і rules у `packages/game`.
Заплановано:

- start game з ready room;
- current game state projection;
- player commands;
- public/private state serialization;
- game events через Socket.IO;
- finish game та повернення room до `waiting`;
- game history/event cursor.

Frontend не повинен залежати від `games.current_state`, `game_events` або raw
persistence events.

## 9. Current limitations

- list rooms endpoint ще не погоджений у `RoomRepository` contract;
- room rules поки placeholder schema `{}`;
- realtime має лише join, leave і ready;
- game HTTP/Socket.IO API ще planned;
- PostgreSQL integration tests потребують `TEST_DATABASE_URL`;
- deployment, migrations orchestration і production infrastructure описуються
  окремо database/deployment документацією.
