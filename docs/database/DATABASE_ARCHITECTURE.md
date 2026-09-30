# Catan Web — архітектура бази даних і технічні рішення

Статус: рішення погоджені користувачем; реалізація PostgreSQL v1 готова в `apps/server/src/db/` та `apps/server/migrations/`. Документ зберігає детальні пояснення початкових рішень; фізична схема, API й порядок запуску додані в розділах 24–29. Серверні application modules підключає їхній розробник окремо.

Серверні application contracts і стан погодження з крудільщиком винесено до [SERVER_DATABASE_CONTRACTS.md](SERVER_DATABASE_CONTRACTS.md). Розділ 23 цього документа відповідає на попередній перелік із дев’яти питань про DB-модель.

---

## 1. Межі відповідальності

Глобальна архітектура проєкту прийнята такою:

```text
Frontend
   |
   v
Server --------> Game Logic
   |
   v
PostgreSQL
```

Сервер є центральним вузлом системи.

### Сервер відповідає за

- authentication та authorization;
- роботу з кімнатами;
- перевірку права користувача виконувати операцію;
- завантаження потрібних даних із БД;
- виклик game logic;
- збереження результатів роботи game logic;
- створення ігрових подій;
- формування public DTO;
- Socket.IO / HTTP transport;
- транзакції;
- узгодженість між станом гри та журналом подій.

### Game Logic відповідає за

- чисті правила Catan;
- перевірки, які є саме правилами гри;
- перетворення `state + command -> new state + domain events[]` або domain error.

Game Logic **не повинна знати** про PostgreSQL, SQL, Fastify, Socket.IO, HTTP, session cookies або repository implementations. Сервер створює власні системні events і передає їх разом із state до DB repository, який додає persistence metadata. Межі погоджені в `SERVER_DATABASE_CONTRACTS.md`; вкладені Catan types належать власнику game logic.

### Database layer відповідає за

- PostgreSQL connection pool;
- SQL-запити;
- транзакції;
- мапінг database rows у внутрішні типи;
- repository implementations;
- міграції;
- constraints, indexes та цілісність даних.

---

## 2. Єдина СУБД: PostgreSQL

Було розглянуто комбінацію PostgreSQL + MongoDB, але від неї відмовилися.

Причина: PostgreSQL із `JSONB` покриває потрібну document-like частину даних, але при цьому не створює проблем двох окремих СУБД.

Прийняте рішення:

```text
PostgreSQL only
```

Використовуємо:

```text
relational tables
+
JSONB snapshots / JSONB payloads
```

Переваги для нашого випадку:

- одна СУБД;
- одна система міграцій;
- foreign keys;
- ACID-транзакції;
- одна система backup;
- одна система connection pooling;
- немає міжбазової узгодженості;
- можна атомарно зберігати новий GameState і відповідний GameEvent;
- JSONB дозволяє не розкладати весь стан поля на десятки таблиць.

---

## 3. Data Access Layer

Серверна структура `apps/server/src/db` приймається як Data Access Layer.

Цільова ідея:

```text
application service
       |
       v
repository interface
       |
       v
PostgreSQL repository implementation
       |
       v
PostgreSQL
```

SQL не повинен бути в HTTP routes, Socket.IO handlers або application services.

Рекомендована структура:

```text
apps/server/src/db/
├── pool.ts
├── transaction.ts
├── health.ts
├── types.ts
└── repositories/
    ├── pg-user.repository.ts
    ├── pg-oauth-account.repository.ts
    ├── pg-session.repository.ts
    ├── pg-room.repository.ts
    ├── pg-game.repository.ts
    └── pg-game-event.repository.ts
```

Інтерфейси repositories можуть залишатися біля відповідних feature modules, якщо це зручно application layer, але PostgreSQL-реалізації повинні бути в `db`.

Наприклад:

```text
auth/user.repository.ts              -> interface
src/db/repositories/pg-user...       -> implementation
```

Це не принципова вимога до назв файлів, але принцип розділення має зберігатися.

---

## 4. Міграції

Усі зміни фізичної схеми PostgreSQL мають проходити через SQL-міграції:

```text
apps/server/migrations/
```

Не створюємо production schema вручну через pgAdmin.

pgAdmin використовується для:

- перегляду;
- ручних SQL-запитів;
- debugging;
- аналізу планів;
- перевірки даних.

Джерелом істини структури БД є migration files у Git.

---

## 5. Основні сутності верхнього рівня

На поточному етапі бачимо такі persistent сутності:

```text
users
oauth_accounts
sessions

rooms
room_members

games
game_players
game_events
```

Пізніше можуть бути додані таблиці або поля для:

- account statistics;
- match history queries;
- агрегованої статистики;
- фінального стану гри;
- додаткових gameplay metadata.

Ці речі фізично ще не фіксуємо остаточно.

---

## 6. Користувачі та guest users

Крудільщик уже реалізував auth-модель, де guest отримує локальний `User` та server-side `Session`.

Цю модель приймаємо.

Тобто guest теж зберігається в `users`:

```text
users
- id
- display_name
- is_guest
- username nullable
- email nullable
- password_hash nullable
- avatar_url nullable
- created_at
```

### Registered user

```text
is_guest = false
```

### Guest user

```text
is_guest = true
username = NULL
email = NULL
password_hash = NULL
```

Guest може:

- створити/мати server-side session;
- входити в кімнату;
- грати в матчі;
- бути присутнім у `game_players`;
- бути присутнім у фінальному записі матчу.

Guest **не має персональної статистики та персональної історії акаунта**.

При цьому історія самого матчу повинна залишатися повною і може містити guest-учасників.

---

## 7. Авторизація

На основі поточного auth коду БД повинна підтримувати такі операції:

```text
createGuestUser
createOAuthUser
createPasswordUser
findUserById
findUserByUsername
findUserByEmail
findOAuthAccount
linkOAuthAccount
createSession
findSessionByTokenHash
revokeSession
```

Базові таблиці:

```text
users
oauth_accounts
sessions
```

### Обмеження, які мають гарантуватися БД

- `users.username` — унікальний без урахування регістру, коли не NULL; це відповідає поточному case-insensitive lookup в auth-коді;
- `users.email` — нормалізується до lowercase перед записом і пошуком та є унікальним, коли не NULL; кілька NULL дозволені;
- `oauth_accounts(provider, provider_account_id)` — унікальна пара;
- `sessions.user_id` — foreign key на `users.id`;
- `oauth_accounts.user_id` — foreign key на `users.id`.

Password hash зберігається тільки у хешованому вигляді. Поточна реалізація використовує `scrypt`.

Session token у БД зберігається як hash, не як raw token.

Поточний JSON repository порівнює email буквально. Перш ніж підключити PostgreSQL repository, серверний OAuth lookup треба узгодити з нормалізацією email. Сесія перевіряється на expiration і revoke незалежно від майбутнього cleanup job. Видалення expired sessions можна організувати пізніше; guest user не видаляється автоматично, доки не погоджено збереження історичних посилань із `game_players`.

---

## 8. Room і Game — різні сутності

Це принципове рішення.

```text
ROOM 1 : N GAME
```

Одна кімната може породити багато матчів.

Одночасно вона може мати не більше однієї **відкритої** Game: `created` або `active`. Обидва статуси резервують Room; `finished` залишається історією. Це сильніше за вимогу «не більше однієї active Game» і прибирає гонку між створенням та запуском.

Причина: після завершення матчу кімната не розпускається, ті самі учасники можуть залишитися разом і натиснути rematch.

Приклад:

```text
Room #ABC
├── Game #1 finished
├── Game #2 finished
└── Game #3 active
```

Кімнату **не потрібно перестворювати** для rematch або зміни правил наступної гри.

---

## 9. Стани кімнати

Кімната має рівно три логічні стани:

```text
waiting
active
closed
```

### waiting

Кімната існує, учасники можуть приєднуватися/готуватися, немає активного матчу.

### active

У кімнаті зараз іде матч.

### closed

Кімната остаточно закрита.

Статусу `finished` у кімнати немає.

Коли матч завершується:

```text
GAME.status -> finished
ROOM.status -> waiting
```

Room не знищується після завершення Game.

Інваріант: `waiting` не має відкритої Game, `active` має рівно одну, а `closed` не запускає новий матч. Start і finish змінюють Room та Game в одній транзакції. Реалізація використовує partial unique index на одну Game зі статусом `created` або `active`, блокування рядка Room і deferred constraint triggers для перевірки фінального стану транзакції. Закриття активної Room повертає `INVALID_STATE_TRANSITION`.

---

## 10. Room members і Game players — різні поняття

`room_members` описує membership у lobby.

`game_players` описує участь у конкретному матчі.

Це не одна й та сама сутність.

У `game_players` можуть зберігатися речі, які належать тільки конкретному матчу:

- color;
- turn order;
- final victory points;
- placement;
- інші match-specific значення.

Тому зв'язки:

```text
USER 1:N ROOM_MEMBER N:1 ROOM
USER 1:N GAME_PLAYER N:1 GAME
ROOM 1:N GAME
```

---

## 11. Налаштування правил і rematch

Кімната зберігає поточні налаштування, які будуть використані для наступної гри.

Умовно:

```text
rooms.current_rules
```

Прийнятий логічний формат — JSONB із Zod-контрактом правил, спільним для `rooms.current_rules` і `games.rules_snapshot`. Версію формату правил потрібно передбачити в контракті. Точний перелік опцій визначається разом із `packages/game`.

При старті нового матчу сервер створює **snapshot правил** у Game:

```text
rooms.current_rules
        |
        | copy on game creation
        v
games.rules_snapshot
```

`games.rules_snapshot` не змінюється під час гри.

Після завершення матчу host може змінити налаштування кімнати, і наступний Game отримає інший snapshot.

Це дозволяє зберегти історичну правильність кожного матчу.

---

## 12. GameState

GameState робимо як snapshot у PostgreSQL JSONB.

Основна ідея:

```text
games.current_state JSONB
```

В `current_state` може входити:

- board;
- hexes;
- roads;
- settlements/cities;
- players' game state;
- resources;
- development cards;
- bank;
- robber;
- current turn;
- current phase;
- інші runtime gameplay fields.

GameState не потрібно розкладати на десятки реляційних таблиць тільки заради збереження поточного runtime state.

### Важливе правило

`current_state` — це **актуальний snapshot**, а не історія.

Ми не складаємо всі старі стани в один JSONB.

Від `games.version`, що використовується для optimistic concurrency і змінюється з кожним успішним transition, відділяємо `games.state_schema_version`. Остання позначає формат `current_state` і не збільшується автоматично з кожним ходом. Невідомий формат дає `UNSUPPORTED_PERSISTED_VERSION`; DB repository викликає переданий версійний parser при читанні й перед зміною. Міграцію старого формату визначає власник GameState, без тихої підстановки defaults.

---

## 13. Game Events

Кожна ігрова дія/подія має зберігатися окремо.

`game_events` — обов'язкова частина моделі, а не optional feature "на майбутнє".

Причини:

- системний game log;
- debugging;
- audit;
- можливість replay у майбутньому;
- аналіз матчу;
- відстеження причин поточного стану;
- відновлення контексту.

Базова модель:

```text
game_events
- id
- game_id
- sequence_number
- event_type
- actor_player_id nullable
- payload JSONB
- payload_schema_version
- created_at
```

Фізичні назви та типи ще можуть бути уточнені.

`(game_id, sequence_number)` має бути унікальною парою; номер зростає в межах Game і виділяється в транзакції запису події. Nullable `actor_player_id`, коли заданий, повинен посилатися на `game_players.id` **тієї самої Game**. Одного FK на `game_players.id` недостатньо для перевірки збігу `game_id` — це має забезпечити фізична схема.

`event_type` є стабільним текстовим кодом події, `payload` — JSONB object із полями, специфічними для цього типу. Тип не треба дублювати всередині `payload`: приклади JSON нижче ілюструють domain event до мапінгу на DB row. Для кожної пари `event_type` + версія payload потрібна Zod-схема; `payload_schema_version` має тип `integer` з перевіркою `> 0`. Новий тип або несумісна зміна payload додаються через версійований контракт, а не через тиху зміну значення старих подій.

Початковий каталог для узгодження з `packages/game`: `GAME_STARTED`, `TURN_STARTED`, `DICE_ROLLED`, `RESOURCES_DISTRIBUTED`, `ROAD_BUILT`, `MARITIME_TRADE`, `PLAYER_DISCONNECTED`, `LONGEST_ROAD_CHANGED`, `GAME_FINISHED`. Це початкові коди з уже описаних сценаріїв, **не твердження про повний набір правил Catan**. Нові коди додаються разом із командами та Zod-схемами до реалізації відповідної дії. Наприклад, для `ROAD_BUILT` payload може містити `edgeId`, а для `MARITIME_TRADE` — `give` і `receive`; остаточні поля та приватність затверджуються в game/server contract.

### Чому `payload JSONB`

Різні events мають різний payload.

Наприклад:

```json
{
  "type": "MARITIME_TRADE",
  "give": { "resource": "WOOD", "amount": 4 },
  "receive": { "resource": "ORE", "amount": 1 }
}
```

або:

```json
{
  "type": "BUILD_ROAD",
  "edgeId": "..."
}
```

Тому JSONB payload природніший, ніж десятки nullable колонок.

---

## 14. GameEvent і системний game log — це одна інформація

Ми не хочемо зберігати системний лог як готовий текст типу:

```text
"Гравець X обміняв 4 дерева на 1 руду"
```

Основним source of truth є структурований `GAME_EVENT`.

Frontend або server serializer може з нього сформувати локалізований текст.

Сирий event payload не є public DTO: він може містити приховані дані. Live broadcast і читання історії мають використовувати проєкцію event для конкретного адресата, як і публічна проєкція GameState. Це стосується також завершених матчів.

Приклад:

```text
GAME_EVENT: MARITIME_TRADE
payload: { give: ..., receive: ... }
```

UI перетворює це на:

```text
Max обміняв 4 картки дерева на 1 картку руди.
```

Переваги:

- локалізація;
- зміна формулювань без міграції даних;
- іконки;
- replay;
- аналітика;
- SQL/JSONB-фільтрація;
- debugging.

---

## 15. Не лише дії гравця

`GAME_EVENT` ширше за `GAME_ACTION`.

Event може бути породжений не лише прямою дією гравця.

Наприклад:

```text
GAME_STARTED
TURN_STARTED
DICE_ROLLED
RESOURCES_DISTRIBUTED
ROAD_BUILT
PLAYER_DISCONNECTED
LONGEST_ROAD_CHANGED
GAME_FINISHED
```

Тому `actor_player_id` може бути NULL.

---

## 16. Event Sourcing не використовуємо

Наявність `game_events` не означає повний event sourcing.

Ми **не плануємо** при кожному завантаженні гри відтворювати сотні events для реконструкції GameState.

Прийнята модель:

```text
games.current_state JSONB    = актуальний snapshot
game_events                  = історія подій
```

При restart сервер завантажує `current_state`.

Events існують як історія, audit/debug log і база для потенційного replay.

---

## 17. Атомарність: state + event

Коли команда змінює стан гри, збереження нового GameState і відповідного Event повинно бути атомарним.

Приклад логіки:

```text
BEGIN

UPDATE games SET current_state = ...
INSERT INTO game_events (...)

COMMIT
```

Якщо будь-яка частина падає:

```text
ROLLBACK
```

Не повинно бути ситуації:

- state змінився, але event не записався;
- event записався, але state не змінився.

Попередній application/database contract для такого переходу:

```text
saveTransition(gameId, expectedVersion, newState, events[])
```

Для успішної зміни стану `events[]` не порожній. У тій самій транзакції перевіряємо очікувану concurrency `version`, записуємо `current_state` і відповідну `state_schema_version`, збільшуємо `version` на один та додаємо всі events із послідовними номерами. Public projection і broadcast виконуються тільки після commit. Якщо `version` застаріла, повертаємо контрольований conflict без тихого перезапису.

---

## 18. Concurrency і version

Для однієї Game команди повинні застосовуватися послідовно.

Ми погоджуємося з ідеєю optimistic concurrency через `version` або еквівалентний механізм.

У `games` доцільно мати:

```text
version
```

Оновлення може виглядати концептуально так:

```sql
UPDATE games
SET current_state = $new_state,
    version = version + 1
WHERE id = $game_id
  AND version = $expected_version;
```

Якщо `updated rows = 0`, стан уже був змінений іншою командою.

Точний concurrency implementation узгодимо перед фізичною реалізацією.

Старт Game та переведення Room у `active`, а також завершення Game з фінальним event і повернення Room у `waiting`, мають бути атомарними. Повторне застосування команди після conflict можливе лише після перечитування стану й повторної перевірки; автоматично відтворювати її на новішому стані не можна.

---

## 19. Історія матчів

Історію матчів зберігаємо.

У майбутньому повинні зберігатися:

- результат;
- учасники;
- переможець;
- фінальні очки;
- кінцевий стан поля;
- правила цього матчу;
- пов'язаний event log.

Але **зараз фізичну реалізацію match history не проєктуємо остаточно**.

Це буде окремий етап після основної схеми.

---

## 20. Фінальний стан поля

Фінальний стан поля має зберігатися для історії матчу.

Рішення на цей етап: фінальним станом залишається `games.current_state` після останнього transition. Він не видаляється після завершення Game, а для історичного перегляду формується його публічна проєкція. Окреме поле зараз не потрібне.

Раніше розглядався можливий майбутній варіант:

```text
games.final_state JSONB
```

До окремого архівного формату чи поля повернемося, якщо GameState почнуть очищати або якщо для історії знадобиться інший контракт.

Зараз важливо лише зафіксувати вимогу: фінальне поле повинно бути доступне після завершення матчу.

---

## 21. Player chat

Окрім системного game log буде другий room/game chat для звичайного спілкування гравців.

Він живе лише в межах конкретної гри.

На поточному етапі рішення:

- player chat **не є частиною постійної історії матчу**;
- player chat **не входить у концептуальну БД як обов'язкова persistent сутність**;
- його можна тримати в RAM, якщо втрата повідомлень при server restart допустима.

Якщо пізніше буде вимога відновлювати player chat після reconnect/server restart, можна додати тимчасову persistence-таблицю та очищати її після завершення гри.

Поки цього не робимо.

---

## 22. Підсумкова модель на цей момент

```text
USERS
  |
  +----< OAUTH_ACCOUNTS
  |
  +----< SESSIONS
  |
  +----< ROOM_MEMBERS >---- ROOMS
  |                           |
  |                           | 1:N
  |                           v
  +----< GAME_PLAYERS >----- GAMES
                               |
                               +-- rules_snapshot
                               +-- current_state JSONB
                               +-- version
                               +-- state_schema_version
                               |
                               +----< GAME_EVENTS
```

Room lifecycle:

```text
waiting -> active -> waiting -> active -> ... -> closed
```

Game lifecycle:

```text
created -> active -> finished
```

Persistence gameplay model:

```text
current_state JSONB = актуальний snapshot
game_events          = історія structured events
```

---

## 23. Відповіді на попередні питання DB-моделі

Попередній перелік питань перед SQL-схемою містив дев'ять пунктів. Нижче збережено прийняті відповіді та межі того, що ще невідомо. Поточний `SERVER_DATABASE_ALIGNMENT.md` містить інший перелік — вісім питань про server/database boundary; відповіді на них наведено в [документі контрактів](SERVER_DATABASE_CONTRACTS.md).

| Питання | Поточне рішення |
| --- | --- |
| Версія формату GameState | Додаємо окремий логічний атрибут `games.state_schema_version`; `games.version` залишається лічильником конкурентних оновлень. |
| Event types і `payload` | Початкові коди наведені в §13. `event_type` — текстовий код, `payload` — JSONB object без дублювання типу, `payload_schema_version` задає версію Zod-схеми. Каталог розширюємо разом із командами `packages/game`. |
| Порядок events | Гарантуємо `UNIQUE(game_id, sequence_number)` і виділяємо номери в транзакції запису подій. |
| `actor_player_id` | Nullable посилання на `game_players` саме цієї Game; фізичний FK або еквівалентне обмеження має перевіряти також `game_id`. |
| `current_rules` / `rules_snapshot` | Обидва — JSONB за спільним версійованим Zod-контрактом правил. Snapshot Game незмінний після створення. |
| Email | Нормалізуємо до lowercase до запису й lookup; унікальний для non-NULL. Auth-код потрібно привести до цього правила. |
| Окреме `games.final_state` | Зараз не додаємо: фінальний `current_state` зберігається після завершення матчу. |
| Одна відкрита Game в Room | Обмеження унікальності для `created`/`active` плюс серіалізація start/finish транзакцій Room. |
| Cleanup | Expired/revoked sessions не проходять auth і можуть видалятися фоновим batch cleanup після завершення строку дії; точний розклад не впливає на correctness. У v1 guest users автоматично не видаляємо, щоб не зламати історичні `game_players`. |

Точні серверні контракти, обробка подій і стан їх погодження винесені до [SERVER_DATABASE_CONTRACTS.md](SERVER_DATABASE_CONTRACTS.md). На рівні БД залишається правило: repository interface може бути біля feature module, а PostgreSQL implementation і SQL — у `apps/server/src/db/`.

Майбутню policy видалення історичних guest users, таблиці персональної статистики, індекси для event analytics, persistence player chat і окремий архівний формат фінального поля не фіксуємо в першій міграції. У v1 guest users залишаються, а sessions можна очищати асинхронно; незалежно від запуску cleanup, session expiration/revocation і цілісність історії Game є обов'язковими.

---

## 24. Реалізована фізична схема v1

Джерело істини — [`001_initial.sql`](../../apps/server/migrations/001_initial.sql). Усі ID мають PostgreSQL тип `uuid`; їх створює Node `randomUUID()`, розширення PostgreSQL для UUID не потрібне. Дати — `timestamptz`, на межі repository — ISO strings. Усі перелічені поля `NOT NULL`, окрім явно позначених nullable. JSONB верхнього рівня завжди object.

### 24.1. `users`

| Поле | Тип / умова | Призначення |
| --- | --- | --- |
| `id` | uuid PK | Локальна ідентичність для всіх способів входу. |
| `display_name` | text, непорожній після trim | Відображуване ім'я. |
| `is_guest` | boolean | Guest лишається User. |
| `username` | text nullable, 3–30 ASCII letters/digits/underscore | Username/password account. |
| `email` | text nullable, lowercase/trim, непорожній | Нормалізований email. |
| `email_verified` | boolean, default false | Передумова автоматичного OAuth linking. |
| `password_hash` | text nullable | Уже обчислений сервером password hash. |
| `avatar_url` | text nullable | OAuth profile. |
| `created_at` | timestamptz, default now() | Час створення. |

Partial unique indexes: `lower(username)` для non-NULL; `email` для non-NULL. Guest не може мати username, email, password hash чи verified email. Verified email вимагає non-NULL email. Repository не хешує пароль і не перевіряє Google credentials: він отримує вже перевірені application inputs.

### 24.2. `oauth_accounts`

Поля: `id uuid PK`, `user_id uuid FK users`, `provider text`, `provider_account_id text`, `created_at timestamptz default now()`. Provider і provider account ID непорожні. Unique `(provider, provider_account_id)` не допускає прив'язки однієї зовнішньої ідентичності до двох User. Індекс за `user_id`; видалення User при наявній binding заборонено (`RESTRICT`). Поточний TypeScript contract підтримує Google; SQL не потребуватиме зміни для наступного provider.

`createOAuthUser` вставляє User і binding однією транзакцією. Конфлікт provider pair відкочує також User. `linkOAuthAccount` блокує User, перевіряє `!isGuest && emailVerified`, не переприв'язує зайняту provider pair і є ідемпотентним для вже наявної правильної binding. Перевірка verified provider email та відповідності email користувачу залишається application precondition.

### 24.3. `sessions`

Поля: `id uuid PK`, `user_id uuid FK users ON DELETE CASCADE`, `token_hash text UNIQUE`, `created_at timestamptz`, `expires_at timestamptz`, `revoked_at timestamptz nullable`. `token_hash` — 64 lowercase hex символи; plaintext token не зберігається. `expires_at > created_at`.

Індекси: unique token hash для lookup, `user_id`, `expires_at`. Lookup повертає тільки `revoked_at IS NULL AND expires_at > now()`. Expired/revoked/missing дають `undefined`. Revoke повторної/відсутньої session безпечний. `cleanupExpiredSessions(limit = 500)` видаляє лише expired sessions пакетами до 1000 з `FOR UPDATE SKIP LOCKED`; User не видаляє. Планувальник виклику належить серверу/операційному середовищу.

### 24.4. `rooms` і `room_members`

| Таблиця / поле | Тип / умова |
| --- | --- |
| `rooms.id` | uuid PK |
| `code` | text UNIQUE, trim/uppercase, 1–32 символи |
| `name` | text, 1–100 символів після trim |
| `host_user_id` | uuid FK users RESTRICT |
| `status` | text CHECK waiting / active / closed, default waiting |
| `capacity` | smallint > 0; допустимий за rules склад визначає server/game |
| `version` | integer > 0, default 1 |
| `current_rules` | jsonb object |
| `rules_schema_version` | integer > 0 |
| `created_at` | timestamptz default now() |
| `room_members.room_id` | uuid FK rooms CASCADE |
| `room_members.user_id` | uuid FK users RESTRICT |
| `ready` | boolean default false |
| `joined_at` | timestamptz default now() |

Membership PK — `(room_id, user_id)`, додатковий індекс за `user_id`. Deferred FK `(rooms.id, host_user_id) → room_members(room_id, user_id)` гарантує, що host є учасником своєї Room. Тому створення кімнати та membership host відбуваються разом. При виході host спочатку потрібен `transferHost` на наявного учасника.

Усі lobby mutations блокують рядок Room через `FOR UPDATE`; паралельні join не перевищать capacity. Membership/ready/rules/host/status mutations збільшують Room version. Повторний join або встановлення того самого ready не збільшують version. Зміна rules вимагає host і `expectedVersion`, скидає ready. Вихід відсутнього non-host і повторне закриття вже закритої Room ідемпотентні. Закриття зберігає рядок Room та її історію. Жодного універсального `updateRoomStatus` назовні немає: active/waiting встановлюють start/finish.

### 24.5. `games`

| Поле | Тип / умова | Призначення |
| --- | --- | --- |
| `id` | uuid PK | Окремий ID кожного матчу/rematch. |
| `room_id` | uuid FK rooms RESTRICT | Room 1:N Game. |
| `status` | text CHECK created / active / finished | Start v1 одразу записує active. |
| `rules_snapshot` | jsonb object | Незмінна копія Room rules. |
| `rules_schema_version` | integer > 0 | Формат rules snapshot. |
| `current_state` | jsonb object | Повний authoritative snapshot із private fields. |
| `state_schema_version` | integer > 0 | Формат snapshot, не concurrency counter. |
| `version` | integer > 0, default 1 | Concurrency version. |
| `last_sequence_number` | integer >= 0, default 0 | Останній event номер; збільшується під row lock. |
| `created_at` | timestamptz default now() | Старт матчу. |
| `finished_at` | timestamptz nullable | Non-NULL рівно тоді, коли status = finished. |

Partial unique index `games_one_open_per_room(room_id) WHERE status IN ('created','active')` гарантує максимум одну відкриту Game. History index — `(room_id, created_at DESC, id)`.

Trigger `games_history_guard` забороняє змінювати `room_id`, rules snapshot або його schema version; після finish забороняє будь-яку зміну рядка Game. Фінальний `current_state` лишається у цьому рядку. Deferred triggers на Room і Game перевіряють перед commit відповідність статусу Room та кількості відкритих Games. Тимчасовий проміжний стан усередині start/finish дозволений, несумісний commit — ні.

### 24.6. `game_players`

Поля: `id uuid PK`, `game_id uuid FK games RESTRICT`, `user_id uuid FK users RESTRICT`, `color text` (непорожній), `turn_order integer >= 0`. Unique: `(game_id, id)`, `(game_id, user_id)`, `(game_id, color)`, `(game_id, turn_order)`. Додатковий індекс за `user_id`.

GamePlayer — історичний склад конкретного матчу. Repository створює його під час start і не надає mutation методів для зміни чи видалення. Вихід із Room після finish не змінює GamePlayer; rematch створює нові player IDs. Послідовність turn order і допустимі кольори за rules перевіряє server/game; БД гарантує невід'ємність та відсутність дублів.

### 24.7. `game_events`

| Поле | Тип / умова |
| --- | --- |
| `id` | uuid PK, створює DB repository |
| `game_id` | uuid FK games RESTRICT |
| `sequence_number` | integer > 0, UNIQUE разом із game_id |
| `game_version` | integer > 0, версія transition, що створив event |
| `event_type` | text, uppercase code `[A-Z][A-Z0-9_]*` |
| `actor_player_id` | uuid nullable, composite FK (game_id, actor_player_id) → game_players |
| `audience` | text CHECK public / player / server |
| `recipient_player_id` | uuid nullable, composite FK у ту саму Game |
| `payload` | jsonb object |
| `payload_schema_version` | integer > 0 |
| `created_at` | timestamptz default now() |

Recipient обов'язковий рівно для `audience = player`. Actor/recipient іншої Game відхиляється FK. Index `(game_id, game_version)` використовується для повторного finish; unique `(game_id, sequence_number)` — для history pagination. Sequence присвоюється послідовно під lock Game, а rollback не залишає проміжків від невдалої операції. Усі events одного переходу мають однакову Game version. Timestamp може збігатися; порядок визначає sequence.

Event history лише доповнюється через repository API: update/delete events відсутні. Це не означає заборону прямого administrative SQL: права production role на таблиці налаштовуються під час розгортання. Сирі payload і metadata — внутрішні; public projection робить сервер.

## 25. DB модулі та конкретний API

Публічний entry point — [`src/db/index.ts`](../../apps/server/src/db/index.ts). Контракти не імпортують feature modules; repositories не залежать від Fastify, Socket.IO чи реалізації Catan.

```text
db/
  contracts/auth.ts, room.ts, game.ts   внутрішні repository ports/types
  pool.ts, health.ts, transaction.ts    PostgreSQL infrastructure
  migrate.ts                           SQL migration runner і окремий CLI
  input.ts, rows.ts                     validation і row mapping
  repository.errors.ts, errors.ts       stable errors і SQLSTATE mapping
  repositories/pg-auth.repository.ts
  repositories/pg-room.repository.ts
  repositories/pg-game.repository.ts
  tests/boundary.test.ts
  tests/persistence.test.ts
```

`PgAuthRepository(pool)` групує User/OAuth/Session operations, щоб зберегти форму чинного auth API і атомарний `createOAuthUser`. `PgRoomRepository(pool, rulesCodec)` працює з lobby. `PgGameRepository(pool, gameCodec)` разом зберігає Game, GamePlayers і GameEvents; окремого writer для events, який обійшов би transition, немає.

Обов'язкові залежності валідаторів:

```ts
interface RulesCodec<Rules> {
  parseRules(version: number, value: unknown): Rules;
}
interface GamePersistenceCodec<State, Rules> extends RulesCodec<Rules> {
  parseState(version: number, value: unknown): State;
  parseEvent(event: GameEventInput): GameEventInput;
  parseSystemEvent(event: GameEventInput): GameEventInput;
}
```

Server adapter передає версійні Zod parsers власника game types. `parseEvent` валідовує повний envelope і discriminated payload усіх підтримуваних gameplay/lifecycle/system events. `parseSystemEvent` додатково дозволяє лише system allowlist без gameplay transitions. Parsers мають бути синхронними й детермінованими, без side effects. Невідома версія — `RepositoryError('UNSUPPORTED_PERSISTED_VERSION', ...)`; невалідний новий input — `INVALID_PERSISTENCE_INPUT`; пошкоджені persisted дані — `INTERNAL_SERVER_ERROR`. Generic State/Rules не заміняють runtime validation: без codecs репозиторії створити не можна.

Перед записом DB також перевіряє UUID, позитивні versions, JSON serialization без undefined/NaN/циклів/Date/BigInt і envelope audience/recipient. Під час читання snapshot/rules/events parser викликається повторно. Unknown persisted snapshot забороняє подальший write; жодного default state.

`StoredGame` та `StoredGameEvent` містять private data. `listGamesForRoom(roomId, limit=100)` повертає тільки id/roomId/status/createdAt/finishedAt. `listEvents(gameId, afterSequence=0, limit=100)` повертає внутрішні events у зростаючому порядку з keyset cursor; page limit 1–1000. `loadCurrentState` повертає `{ schemaVersion, state, version } | undefined`. Історія акаунта та статистика не додаються: це лишається відкладеним scope розділів 19, 23.

## 26. Транзакції та конкурентні операції

| Операція | Lock / перевірки | Commit |
| --- | --- | --- |
| `createRoom` | User існує; deferred host membership FK | Room waiting + host member. |
| `createGameFromRoom` | Room FOR UPDATE; host, waiting, expectedRoomVersion, відсутня open Game, усі members ready, точний roster, capacity | Game active v1, rules snapshot, players, start events, Room active/version+1. |
| `saveTransition` | Game FOR UPDATE; active, expectedVersion, supported stored format, state змінився, events непорожні | Snapshot + schemaVersion, version+1, усі events і sequence. |
| `appendSystemEvents` | Game FOR UPDATE; active/version; system parser, непорожні events | Snapshot не змінюється, version+1 і нові events. |
| `finishGame` | Room FOR UPDATE, потім Game FOR UPDATE; active/version, змінений фінальний state, один finish event | Фінальний snapshot і events, Game finished/version+1, Room waiting/version+1, ready=false. |

Усі операції, яким потрібні обидва locks, беруть спочатку Room, потім Game. Звичайний transition блокує лише Game, тому між різними матчами немає спільного lock. PostgreSQL READ COMMITTED + row locks серіалізують writers; comparison `expectedVersion` відбувається **після** отримання актуального заблокованого рядка. Це дає optimistic concurrency для application і не допускає lost update. Унікальні індекси та FK лишаються незалежним захистом даних.

`createGameFromRoom` приймає `id`, `roomId`, `hostUserId`, `expectedRoomVersion`, `initialState`, `players[]`, `events[]`. Сервер резервує game/player UUID, щоб використати їх у початковому state. Rules беруться з заблокованої Room; expectedRoomVersion захищає від зміни rules/roster/ready між читанням і start. Окрема передана копія rules не потрібна й не може розійтися з Room.

Caller додає рівно один `GAME_STARTED` при start і рівно один `GAME_FINISHED` при finish. Regular/system write забороняє обидва lifecycle types. Repository присвоює event IDs, sequence, gameVersion та timestamps. `saveTransition` не приймає порожній batch або семантично незмінений JSON state. Return надається після успішного commit. Failed query/deferred constraint/codec відкочує всі записи; database client повертається в pool лише після rollback, а зламаний client знищується.

Повторний finish спочатку читає persisted status. Якщо Game finished — повертає `alreadyFinished`, фінальний snapshot і events її фінальної version; повторно не валідовує відкинутий новий state/events, не збільшує version, не скидає новий ready. Room у відповіді є **поточна**: якщо вже почався rematch, старий retry не повертає Room у waiting і не зачіпає нову Game. Повторний start при відкритій Game дає `GAME_ALREADY_OPEN`.

Конфлікт version, serialization failure і deadlock дають `CONCURRENCY_CONFLICT`; автоматичного retry ігрової команди немає. Невідома SQL constraint failure дає `INTERNAL_SERVER_ERROR`. Відомі unique conflicts мапляться по конкретних constraint names: email/provider → ACCOUNT_CONFLICT, username → USERNAME_TAKEN, room code → ROOM_CODE_TAKEN, open game → GAME_ALREADY_OPEN. Capacity conflict — ROOM_FULL. Transport mapping залишається за сервером. SQLSTATE/constraint не є public полями error; технічний `cause` призначений тільки для внутрішнього logging.

## 27. Migration runner і запуск

`migrate(pool)` застосовує нумеровані SQL-файли `001_name.sql`, `002_name.sql` у порядку імен. Використовує session advisory lock на database/schema, тому два runners не виконують DDL паралельно. Таблиця `schema_migrations(name text PK, checksum text, applied_at timestamptz)` ведеться самим runner. Кожен файл і його ledger row — одна транзакція; повторний запуск пропускає застосовані файли. SHA-256 нормалізує CRLF у LF; змінений або відсутній уже застосований файл та додана заднім числом migration зупиняють runner. Після публікації migration виправляється новим SQL-файлом.

Pool/repositories отримують config через аргументи; environment читає лише standalone migration CLI. `createPool({ connectionString, max?, options?, onIdleError? })` має default max=10, connection timeout 5 секунд, idle timeout 30 секунд. `checkDatabase(pool)` виконує SELECT 1 та повертає typed error при невдачі. Власник pool викликає `pool.end()` при shutdown; migration CLI робить це сам. `onIdleError` дозволяє підключити внутрішній logger без прив'язки DB до серверної logging бібліотеки.

PowerShell із кореня репозиторію, на вже створеній цільовій БД:

```powershell
$env:DATABASE_URL = 'postgresql://USER:PASSWORD@127.0.0.1:5432/catan_dev'
npm.cmd exec --workspace @catan/server -- tsx src/db/migrate.ts
```

Runtime після build може запускати `node apps/server/dist/db/migrate.js`; SQL-файли `apps/server/migrations/` потрібно доставляти разом із build. Runner сам не створює database/role, не запускається при імпорті `db/index.ts` і не підключається автоматично до `main.ts`. Автоматичного destructive down немає; для зміни розгорнутої схеми додається forward migration. Імпорт наявних JSON mock accounts/sessions — окрема операція, у цій реалізації такі файли не читаються і не змінюються.

## 28. Перевірки

```powershell
$env:TEST_DATABASE_URL = 'postgresql://USER:PASSWORD@127.0.0.1:5432/catan_test'
npm.cmd exec --workspace @catan/server -- vitest run src/db/tests
npm.cmd run typecheck --workspace @catan/server
npm.cmd run build --workspace @catan/server
```

Integration suite вимагає database name із суфіксом `_test`. Створює випадкову окрему schema, застосовує реальні migrations, виконує справжні SQL queries і прибирає лише власну schema. Якщо TEST_DATABASE_URL не задано, integration tests явно skipped; це не перевірка PostgreSQL. Для DB acceptance потрібен запуск із цією змінною.

Перевірено на окремому PostgreSQL 18 cluster: 20 integration tests і 4 boundary tests. Сценарії включають migration checksum/DDL rollback, concurrent username registration/join/start/transition, OAuth rollback і відсутність rebind, session expiry/revoke/cleanup, room rules/ready/host, rollback state та всіх events при чужому actor, visibility metadata, system-only allowlist, immutable rules/final state, finish retry під час rematch, unsupported stored versions, typed errors і JSON serialization.

## 29. Межа готовності

Готові SQL schema, migration runner, pool/transaction/readiness, repository contracts та PostgreSQL implementations для всіх восьми основних сутностей. Зміни реалізації обмежені `apps/server/src/db/`, `apps/server/migrations/` і двома DB документами.

Крудільщик підключає pool/repositories у composition root, використовує repository ports замість конкретного JSON class, передає production codecs, мапить typed errors, перевіряє actor/authorization та будує public projections. `packages/game` визначає повні Catan state/rules/events і валідний фінальний результат. Для DB API наведені готові типи; server auth/routes/services/main/config та game/shared у цій роботі не змінюються.
