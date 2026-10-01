# Server architecture

Цей документ описує межі серверних модулів, напрямок залежностей і правила
роботи з даними. Він є спільною домовленістю для розробки `apps/server`.

## Основні принципи

- Сервер є authoritative source для користувачів, кімнат і стану гри.
- Зовнішні дані вважаються недовіреними та перевіряються під час виконання.
- HTTP і Socket.IO handlers не містять бізнес-логіки та SQL.
- `packages/game` містить чисті правила гри й не залежить від сервера.
- `packages/shared` містить лише публічні контракти, потрібні клієнту та серверу.
- Приватні поля ніколи не повертаються клієнту через прямий database object.
- Постійні дані зберігаються через repositories, а не безпосередньо у services.

## Загальна структура

```text
apps/server/
├── migrations/                 # SQL-міграції PostgreSQL
└── src/
    ├── main.ts                 # composition root і запуск сервера
    ├── config/                 # env та runtime-конфігурація
    ├── http/                   # Fastify plugins і HTTP infrastructure
    ├── realtime/               # Socket.IO transport
    ├── auth/                   # користувачі та автентифікація
    ├── rooms/                  # lobby та життєвий цикл кімнат
    ├── games/                  # application orchestration гри
    └── db/                     # PostgreSQL data access layer
```

Функціональні модулі (`auth`, `rooms`, `games`) містять application logic.
Transport-модулі (`http`, `realtime`) приймають зовнішні повідомлення, а
`db` відповідає за persistence та інфраструктурний доступ до даних.

## Напрямок залежностей

```text
HTTP / Socket.IO
        ↓
auth / rooms / games       application services
        ↓
repositories (db)         data access
        ↓
PostgreSQL
```

Правила гри викликаються з `games`, але не залежать від жодного шару сервера:

```text
games → packages/game
client / server → packages/shared
```

Зворотні залежності заборонені. Наприклад, repository не повинен викликати
route або `packages/game`, а `packages/game` не повинен імпортувати Fastify,
Socket.IO чи PostgreSQL.

## `main.ts`

`main.ts` є composition root. Він збирає застосунок, але не реалізує
application logic.

Відповідальність:

1. завантажити та перевірити конфігурацію;
2. створити database pool і repositories;
3. створити services;
4. зареєструвати Fastify plugins і routes;
5. підключити Socket.IO;
6. налаштувати graceful shutdown;
7. запустити HTTP server.

У `main.ts` не повинно бути SQL, складних перевірок прав або правил гри.

## `config/`

```text
config/
├── env.ts
└── types.ts
```

`config` читає `process.env`, перевіряє його через Zod і повертає типізований
конфігураційний об'єкт.

Приклади налаштувань:

- `NODE_ENV`;
- `HOST` і `PORT`;
- `DATABASE_URL`;
- `CORS_ORIGIN`;
- Google OAuth credentials;
- session settings.

Обов'язкова змінна з неправильним форматом має зупиняти запуск із явною
помилкою. Не слід використовувати порожні або success-shaped fallback values.

### Модель завантаження конфігурації

Конфігурація завантажується один раз під час складання застосунку:

```text
process.env
   ↓
config/env.ts
   ↓
validated AppConfig
   ↓
main.ts передає потрібні налаштування модулям
```

`config/env.ts` відповідає за читання environment variables, перевірку через
Zod і створення типізованого `AppConfig`. `main.ts` викликає цей loader у
composition root і передає модулям лише потрібні їм частини конфігурації,
наприклад `AuthConfig`, `DatabaseConfig` або `ServerConfig`.

Поточний loader підтримує `NODE_ENV`, `HOST`, `PORT`, `CORS_ORIGIN`,
`DATABASE_URL`, `MOCK_DB_PATH`, Google OAuth credentials,
`SESSION_TTL_SECONDS` і `OAUTH_STATE_TTL_SECONDS`. Google OAuth конфігурація
має бути або повністю відсутня, або повністю задана. `DATABASE_URL` і
`CORS_ORIGIN` валідовуються та передаються як config surface: перший вибирає
PostgreSQL repositories, а другий налаштовує credentialed CORS для HTTP і
Socket.IO. Міграції та database lifecycle залишаються поза application server.

Health, auth і authenticated room endpoints, Socket.IO handshake та room events
обмежуються локальним fixed-window rate limiter за IP, маршрутом, user ID або
event name. Ліміт та вікно задаються `AUTH_RATE_LIMIT_MAX` і
`AUTH_RATE_LIMIT_WINDOW_SECONDS`; перевищення повертає `429 RATE_LIMITED`.
Поточне in-memory сховище достатнє для одного процесу та не є distributed
захистом. Перед горизонтальним масштабуванням storage потрібно замінити на
спільне atomic сховище, не змінюючи route-level contract.

Feature- та infrastructure-модулі не повинні напряму читати `process.env` або
залежати від глобального mutable config singleton. Явні залежності роблять
межі модулів зрозумілими, не прив'язують їх до структури всього `AppConfig` і
дозволяють передавати окрему конфігурацію в тестах без зміни глобального стану.
Тести можуть викликати loader з власним набором environment variables або
передати модулю вузький config object без повторного імпорту модуля.

Передача конфігурації не повинна перетворюватися на прокидання всього
`AppConfig` через усі функції. Кожен створений у `main.ts` об'єкт зберігає лише
мінімальний config slice, необхідний для його роботи.

## `http/`

```text
http/
├── plugins/
│   ├── cors.ts
│   ├── error-handler.ts
│   └── request-context.ts
├── routes/
│   ├── health.routes.ts
│   ├── auth.routes.ts
│   ├── rooms.routes.ts
│   └── games.routes.ts
└── schemas/
    └── common.schemas.ts
```

HTTP route:

1. читає request;
2. валідовує params/query/body;
3. отримує authentication context;
4. викликає application service;
5. повертає публічний response DTO.

Route не виконує SQL і не змінює domain state напряму. HTTP-specific схеми
можуть бути в `http/schemas`, а спільні протокольні схеми — у
`packages/shared`.

## `realtime/`

```text
realtime/
├── socket.ts
├── events.ts
├── middleware/
│   └── authentication.ts
├── handlers/
│   ├── connection.handler.ts
│   ├── room.handler.ts
│   └── game.handler.ts
└── serializers/
    └── game-state.serializer.ts
```

Socket middleware перевіряє session cookie та прикріплює користувача до
socket context. Authentication не означає автоматичний доступ до кожної
кімнати: authorization перевіряється окремо в application service.

Поточний realtime transport створюється в composition root через
`createRealtimeServer(app.server, authService, roomService, authConfig, serverConfig)`.
The returned Socket.IO server is closed through Fastify's `onClose` hook.
Middleware
автентифікує Socket.IO handshake за тією самою session cookie, що й HTTP.
Room events проходять через Zod validation і викликають `RoomService`; сама
Socket.IO room є лише transport projection, а не джерелом стану.

Composition root вибирає persistence adapter за `DATABASE_URL`: PostgreSQL
режим створює один shared pool і передає `PgAuthRepository` та
`PgRoomRepository` у application services. Без цього variable використовується
локальний mock/in-memory режим. Міграції не запускаються автоматично сервером.

Handlers:

1. приймають event payload;
2. валідовують його через Zod;
3. перевіряють authentication/authorization;
4. викликають service;
5. повертають acknowledgement або protocol error.

Serializers формують публічну проєкцію стану. Вони не повинні передавати
приховані карти, приватні дані чи внутрішні поля сервера.

## `auth/`

Поточна реалізація auth вже використовує session cookie та тимчасовий JSON
repository. Після підключення PostgreSQL application API не має змінитися.

Цільова структура:

```text
auth/
├── auth.errors.ts
├── auth.routes.ts
├── auth.schemas.ts
├── auth.service.ts
├── auth.types.ts
├── session.service.ts
├── session.repository.ts
├── user.repository.ts
├── oauth/
│   ├── google.service.ts
│   └── google.types.ts
└── password/
    └── password.service.ts
```

Відповідальність:

- guest user;
- username/password registration і login;
- Google OAuth;
- server-side sessions;
- authentication context;
- account linking у майбутньому.

Усі способи входу завершуються локальним `User` і server-side `Session`.
OAuth token не є сесією застосунку та не зберігається як спосіб доступу до
Catan.

## `rooms/`

```text
rooms/
├── room.service.ts
├── room.repository.ts
├── room.schemas.ts
├── room.types.ts
├── room.errors.ts
└── room.mapper.ts
```

`rooms` відповідає за lobby:

- створення та пошук кімнати;
- join/leave;
- список учасників;
- capacity;
- ready state;
- статус `waiting`, `active` або `closed`;
- запуск game session.

Socket.IO room є transport-механізмом. Він не замінює database room і не є
джерелом істини про учасників.

Початок гри може ініціювати лише host після перевірки authorization,
membership, capacity та ready state. Guest також може бути host, якщо має
дійсний локальний `User` і `Session`. Після завершення гри membership кімнати
зберігається, а ready state скидається для наступного матчу. Правила кімнати
можна змінювати лише у стані `waiting`.

## `games/`

```text
games/
├── game.service.ts
├── game.repository.ts
├── game-session.ts
├── game.schemas.ts
├── game.types.ts
├── game.errors.ts
└── game-state.mapper.ts
```

`games` координує server concerns навколо партії:

1. завантажує game state;
2. перевіряє право гравця діяти;
3. передає команду в `packages/game`;
4. зберігає новий state;
5. створює public projection;
6. публікує оновлення через Socket.IO.

Правила гри мають залишатися чистою операцією на кшталт:

```text
state + command → new state + domain events[] або domain error
```

Перед викликом `packages/game` server перевіряє session, authorization і
membership, а також визначає `actorPlayerId`. У game logic передається
валідована команда з цим player ID, а не cookie, session, database row або
transport context. Клієнт не може сам визначити actor. Системні команди
формує лише server.

Результат команди має одну з форм:

```text
applied   → новий state + одна або більше domain events
unchanged → state без змін; лише для явно ідемпотентних команд
rejected  → domain error; не є успішним transition
```

Некоректний хід не можна маскувати як `unchanged`. Для однієї game session
команди мають оброблятися послідовно. При переході на PostgreSQL
використовується optimistic concurrency через `version` або еквівалентний
узгоджений механізм.

`packages/game` не додає database IDs, sequence numbers або timestamps до
domain events. Ці persistence metadata додаються на server/database boundary.
`packages/game` також не відповідає за Socket.IO visibility.

### Persistence model

Кімната та конкретний матч є різними сутностями:

```text
ROOM 1:N GAME
```

Кімната може пережити завершення матчу та прийняти rematch. Її lifecycle:

```text
waiting -> active -> waiting -> active -> ... -> closed
```

Lifecycle конкретної гри:

```text
created -> active -> finished
```

У v1 `created` є коротким внутрішнім станом операції start: після успішного
commit клієнт бачить Game одразу в `active`, Room — в `active`, а start event
вже збережений. Довготривала `created` Game не є окремим клієнтським
сценарієм.

У кімнаті може бути не більше однієї відкритої Game (`created` або `active`)
одночасно. Завершення гри
повертає кімнату до `waiting`, а не переводить її у `finished`.
Повторний start не створює другу Game і повертає контрольовану application
error. Після finish membership зберігається, ready state скидається, а
повторний finish не створює другий finish event.

Room зберігає налаштування для наступного матчу. Під час створення Game вони
копіюються в незмінний `rules_snapshot`, тому подальша зміна налаштувань
кімнати не змінює історичну конфігурацію вже створеної гри.

Поточний стан гри зберігається як актуальний snapshot:

```text
games.current_state JSONB
```

Snapshot не є історією всіх попередніх станів і має бути версійований на
рівні формату, щоб зміни GameState оброблялися явно.

Кожен результативний transition створює один або кілька структурованих
`game_events`. Events є обов'язковою частиною gameplay persistence для
системного log, debugging, audit і можливого replay.

```text
command
  -> packages/game
  -> new state + events[]
  -> one atomic persistence operation:
       update game snapshot
       append game events
  -> public event/state projection
  -> broadcast
```

Це не повний event sourcing: після restart сервер завантажує `current_state`,
а не відтворює всю історію events.

Збереження state і events має бути атомарним на application/database boundary:

```text
saveTransition(gameId, expectedVersion, newState, events[])
```

`saveTransition` приймає лише реальну зміну state і непорожній `events[]`.
Оновлення дозволяється лише для очікуваної версії. Конфлікт версій повертається
як контрольована application error і не вирішується тихим перезаписом новішого
стану або автоматичним повторним застосуванням команди.

Події без зміни GameState використовують окремий application contract,
наприклад `appendSystemEvents`. Така операція не є другим способом виконати
gameplay transition і не повинна використовуватися для обходу перевірок
`saveTransition`.

### Domain, stored і public events

Події проходять через окремі представлення:

```text
DomainEvent
   ↓
StoredGameEvent
   ↓
public projection для конкретного viewer
   ↓
Socket.IO / HTTP
```

`DomainEvent` описує факт, який виник у game logic або server application
layer. `StoredGameEvent` додає persistence metadata. Public projection
формується server serializer і може відрізнятися для різних гравців.

Raw event payload не є public DTO. Приховані ресурси, development cards та
інші private values не можна передавати всім клієнтам. Та сама projection
policy використовується для live broadcast і history. Server-only events не
публікуються клієнту.

`GAME_STARTED` і `GAME_FINISHED` є server/application lifecycle events.
Gameplay events створює `packages/game`; один event не повинен дублюватися
одночасно game logic і server service.

### Application errors

Feature services працюють із типізованими application errors, а не з
PostgreSQL-specific codes:

```text
NOT_FOUND
INVALID_STATE_TRANSITION
GAME_ALREADY_OPEN
CONCURRENCY_CONFLICT
UNSUPPORTED_PERSISTED_VERSION
DATABASE_UNAVAILABLE
```

Routes і Socket.IO handlers маплять ці помилки у protocol responses.
SQLSTATE, назви constraints та raw database errors не виходять за межі `db`.

## `db/` — Data Access Layer

Так, `db` — це **data access layer (DAL)** та database infrastructure layer.
Він ізолює application logic від PostgreSQL.

```text
db/
├── pool.ts
├── transaction.ts
├── health.ts
├── repositories/
│   ├── user.repository.ts
│   ├── oauth-account.repository.ts
│   ├── session.repository.ts
│   ├── room.repository.ts
│   └── game.repository.ts
└── types.ts
```

Відповідальність DAL:

- створити та закрити PostgreSQL pool;
- виконувати SQL;
- технічно реалізовувати транзакції, визначені application use case;
- мапити database rows у application types;
- повертати контрольовані repository errors;
- не допускати SQL injection через параметризовані запити.

Repository не повинен містити HTTP, Socket.IO або правила гри. Service не
повинен містити SQL або самостійно координувати PostgreSQL transaction
details. Application service визначає межу use case та вимогу атомарності, а
`db` надає відповідний transaction-aware repository contract і реалізує його.
Такий поділ дозволить замінити mock repository на
PostgreSQL repository без переписування auth/rooms/games services.

Міграції зберігаються поза `src`:

```text
apps/server/migrations/
```

За міграції, схему PostgreSQL і реалізацію `db` відповідає розробник,
призначений на database work. Application modules споживають його
repositories через узгоджені інтерфейси.

## DTO та Zod

DTO використовуються на межах системи, а не для кожної внутрішньої функції.
Не можна використовувати database row як HTTP або Socket.IO response.

Категорії:

```text
Input DTO       дані від клієнта
Output DTO      публічні дані до клієнта
Internal type   дані між services
Database row    результат SQL
```

Для зовнішніх даних Zod schema є runtime source of truth:

```ts
const createRoomSchema = z.object({
  name: z.string().trim().min(1).max(50),
});

type CreateRoomInput = z.infer<typeof createRoomSchema>;
```

Правила:

- схема парсить `unknown` на вході;
- тип отримується через `z.infer`;
- не дублюємо однакові типи вручну;
- response проходить через явний mapper/serializer;
- password, session token і внутрішні поля не входять до public DTO.

Схеми, потрібні клієнту й серверу, розміщуються у `packages/shared`. Схеми
для внутрішнього server-only протоколу залишаються в `apps/server/src`.

## Типовий request flow

### HTTP

```text
request
  → route
  → Zod parse
  → authentication
  → application service
  → repository
  → mapper
  → response DTO
```

### Socket.IO

```text
event
  → socket middleware
  → Zod parse
  → authorization
  → application service
  → game rules / repository
  → public serializer
  → broadcast
```

## Database ownership

Для auth потрібні таблиці:

```text
users
oauth_accounts
sessions
```

Для наступних модулів:

```text
rooms
room_members
games
game_players
game_events
```

`game_events` є частиною базової persistence-моделі gameplay. Повний event
sourcing не використовується.

Рекомендовані середовища:

```text
catan_dev
catan_test
catan_staging
catan_production
```

Production database не використовується локально або в CI.

## Де писати новий код

- Новий HTTP endpoint: route у `http/routes` + service у feature module.
- Новий Socket.IO event: handler у `realtime/handlers` + service у feature module.
- Новий SQL-запит: repository у `db/repositories` або feature-specific repository.
- Нова таблиця: міграція в `apps/server/migrations`.
- Новий спільний payload: Zod schema/type у `packages/shared`.
- Нове правило Catan: `packages/game`, без імпорту server modules.

Перед merge зміни мають проходити:

```bash
npm run typecheck
npm test
npm run build
```
