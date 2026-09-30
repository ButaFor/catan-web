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
- статус `waiting`, `active`, `finished` або `closed`;
- запуск game session.

Socket.IO room є transport-механізмом. Він не замінює database room і не є
джерелом істини про учасників.

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
state + command → new state або domain error
```

Для однієї game session команди мають оброблятися послідовно. При переході
на PostgreSQL це може бути транзакція з перевіркою `version` або інший
узгоджений concurrency mechanism.

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
- відкривати транзакції;
- мапити database rows у application types;
- повертати контрольовані repository errors;
- не допускати SQL injection через параметризовані запити.

Repository не повинен містити HTTP, Socket.IO або правила гри. Service не
повинен містити SQL. Такий поділ дозволить замінити mock repository на
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
game_sessions
```

`game_events` можна додати пізніше для replay та audit; повний event sourcing
не є вимогою першої версії.

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
