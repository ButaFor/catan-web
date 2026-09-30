# Catan Web — проміжні рішення щодо бази даних та узгодження із сервером

Статус: розгорнутий документ прийнятих концептуальних рішень і поточного узгодження між розробником БД та крудільщиком. Оновлено після `SERVER_DATABASE_ALIGNMENT.md` і коміту `975c1a7` гілки `yur25`.

Мета цього документа — зберегти детальне обґрунтування всіх прийнятих рішень щодо даних, зафіксувати вже виконане узгодження із серверною архітектурою та чітко назвати контракти, які треба погодити перед фізичним проєктуванням БД і реалізацією SQL-запитів.

Документ поки **не є фінальною фізичною схемою БД**. Крудільщик уже оновив `apps/server/src/SERVER_ARCHITECTURE.md` на концептуальному рівні. Точні application contracts, event payloads і правила міграції форматів стану ще потрібно узгодити перед остаточною схемою, repository API, SQL-запитами, міграціями та індексами. Розділ 22 зберігає детальне пояснення вимог, які привели до оновлення серверної архітектури; розділ 27 фіксує нові рішення.

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

Game Logic **не повинна знати** про PostgreSQL, SQL, Fastify, Socket.IO, HTTP, session cookies або repository implementations. Сервер додає persistence metadata до domain events, створює власні системні events і зберігає їх разом із state; точні типи та межі цього контракту ще погоджуються.

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

Інваріант: `waiting` не має відкритої Game, `active` має рівно одну, а `closed` не запускає новий матч. Start і finish змінюють Room та Game в одній транзакції. Для одночасних запитів потрібні унікальне обмеження на одну Game зі статусом `created` або `active` для Room (наприклад, partial unique index) і серіалізація start/finish транзакцій через блокування рядка Room або еквівалентний механізм. Точний SQL і поведінку закриття Room під час матчу погоджуємо у фізичному дизайні та application contract.

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

Від `games.version`, що використовується для optimistic concurrency і змінюється з кожним успішним transition, відділяємо `games.state_schema_version`. Остання позначає формат `current_state` і не збільшується автоматично з кожним ходом. Невідому версію формату сервер має обробити контрольованою помилкою; правила читання й міграції старих форматів погоджуємо разом із GameState contract.

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

`event_type` є стабільним текстовим кодом події, `payload` — JSONB object із полями, специфічними для цього типу. Тип не треба дублювати всередині `payload`: приклади JSON нижче ілюструють domain event до мапінгу на DB row. Для кожної пари `event_type` + версія payload потрібна Zod-схема; логічно передбачаємо окремий `payload_schema_version`, точний PostgreSQL type визначимо у фізичній схемі. Новий тип або несумісна зміна payload додаються через версійований контракт, а не через тиху зміну значення старих подій.

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

## 22. Вимоги, за якими узгоджено серверну архітектуру

Нижче збережено повний перелік причин і вимог із початкового документа. Крудільщик відобразив основні пункти в `SERVER_ARCHITECTURE.md` комітом `975c1a7`. Цей коміт змінив документацію, а не реалізував PostgreSQL repositories чи application contracts. Поточні невирішені питання наведено в розділах 26–27.

### 22.1. `game_events` більше не optional

У попередній версії `SERVER_ARCHITECTURE.md` було зазначено, що `game_events` можна додати пізніше для replay/audit.

Коміт `975c1a7` змінив цю тезу.

`game_events` — базова частина persistence для Game вже в основній архітектурі.

Причина: кожна ігрова дія має потрапляти в системний log, а системний log будується з structured events.

Тобто server flow має бути ближчим до:

```text
command
 -> load game
 -> authorization
 -> call packages/game
 -> obtain new state + domain events[]
 -> transaction:
      update game state
      append game event(s)
 -> serialize public state/log events
 -> broadcast
```

### 22.2. Room має зв'язок `1:N` з Game

У серверній архітектурі вже зафіксовано:

```text
ROOM 1:N GAME
```

Room не є одним Game.

Room переживає завершення Game і підтримує rematch.

### 22.3. Room не має статусу `finished`

Замість:

```text
waiting / active / finished / closed
```

використовуємо:

```text
waiting / active / closed
```

Після завершення матчу:

```text
Game -> finished
Room -> waiting
```

Причина: кімната не завершується разом із матчем.

### 22.4. Потрібен `rules_snapshot` у Game

Room зберігає налаштування для наступної гри.

При старті Game вони копіюються в immutable snapshot конкретного Game.

Причина: після rematch правила можуть змінитися, але стара гра повинна залишатися історично коректною.

### 22.5. GameState — JSONB snapshot

Крудільщик погодився на нашу модель.

У серверній архітектурі вже закріплено:

```text
games.current_state JSONB
```

Це актуальний persistence snapshot GameState.

Не робимо повний event sourcing.

### 22.6. State і Event зберігаються однією транзакцією

Game service не повинен викликати два незалежних repository writes без спільної транзакції.

Узгоджений попередній DB/API механізм має вигляд:

```text
saveTransition(gameId, expectedVersion, newState, events[])
```

або транзакційний callback, який гарантує атомарність:

```text
new state + event(s)
```

Точні типи DTO, включно з форматами events, узгодимо разом. Жодна реалізація не повинна робити два незалежні writes без спільної транзакції.

### 22.7. Guest залишається User

Поточний auth підхід правильний:

```text
Guest -> User(isGuest=true) -> Session
```

Не потрібно робити окрему сутність guest у БД.

Але downstream code повинен пам'ятати:

- guest може грати;
- guest може бути `game_player`;
- guest не отримує account statistics/history.

### 22.8. `game_sessions` краще перейменувати на `games` на persistence-рівні

У server runtime може існувати `GameSession` як клас/об'єкт.

У серверній архітектурі persistent таблицю вже названо:

```text
games
```

Причина: вже є `sessions` для auth, а `game_sessions` створює зайву термінологічну плутанину.

### 22.9. Repository responsibilities треба залишити чіткими

Application services не повинні містити SQL.

PostgreSQL repositories не повинні містити game rules.

`packages/game` не повинна знати про persistence.

Цей пункт у поточній архітектурі вже правильний — його треба зберегти.

### 22.10. Public serializer не повинен напряму використовувати DB rows

Поточне правило крудільщика правильне і залишається:

```text
Database Row != Public DTO
```

Особливо важливо для GameState через hidden/private data.

Server має формувати public projection окремо.

---

## 23. Що крудільщику не потрібно зараз реалізовувати

Поки не треба самостійно фіксувати:

- остаточну фізичну схему `games`;
- остаточну структуру `game_events.payload`;
- індекси для event analytics;
- фінальну схему match history;
- статистику користувачів;
- retention policy для guests;
- persistence player chat;
- SQL-запити для всієї game частини.

Серверний architecture document уже синхронізовано на концептуальному рівні. Перед фізичним проєктуванням ще потрібно узгодити application contracts, перелічені в розділі 27.

---

## 24. Попередній expected repository API

Це не фінальний API, а напрямок для узгодження.

### Auth

```text
UserRepository
OAuthAccountRepository
SessionRepository
```

### Rooms

Потрібні операції приблизно такого рівня:

```text
createRoom
findRoomById
findRoomByCode
addMember
removeMember
listMembers
updateRoomStatus
updateRoomRules
```

### Games

Потрібні операції приблизно такого рівня:

```text
createGameFromRoom
findGameById
findOpenGameForRoom (або findActiveGameForRoom після уточнення семантики)
loadCurrentState
saveTransition(gameId, expectedVersion, newState, events[])
finishGame
listGamesForRoom
```

Точні method names та DTO узгодимо з крудільщиком. `createGameFromRoom` і `finishGame` мають керувати переходами Room + Game у транзакції, незалежно від того, як саме поділені repository interfaces.

---

## 25. Підсумкова модель на цей момент

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

## 26. Поточний стан узгодження та наступний етап

Коміт `975c1a7` у `yur25` зафіксував у серверній архітектурі `ROOM 1:N GAME`, три статуси Room, `rules_snapshot`, `games.current_state JSONB`, обов'язкові `game_events`, атомарний `saveTransition` і optimistic concurrency. Це узгодження **архітектурного документа**, а не підтвердження готових application contracts або PostgreSQL-коду.

Перед фінальним фізичним дизайном DB side та крудільщик мають погодити точні контракти GameState і правил, каталог подій та payload, публічну проєкцію подій, transaction boundaries для start/finish/transition і обробку concurrency conflict. Деталі наведені в розділі 27.

Після цього створюємо фінальний документ, де вже будуть:

- остаточна логічна схема;
- фізичні таблиці;
- колонки і PostgreSQL types;
- PK/FK/UNIQUE/CHECK constraints;
- JSONB contracts;
- indexes;
- repository interfaces;
- SQL-запити;
- transaction boundaries;
- migration order;
- concurrency behavior;
- history/statistics strategy.

Цей фінальний документ і є фізичним проєктуванням. Реалізацію PostgreSQL persistence починаємо після його узгодження.

---

## 27. Нові рішення після server/database alignment

`SERVER_DATABASE_ALIGNMENT.md` поставив дев'ять питань перед SQL-схемою. Нижче зафіксовано прийняті відповіді та межі того, що ще невідомо. Вони уточнюють розділи вище, а не скасовують їхні пояснення.

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

### Що ще потрібно погодити з крудільщиком

1. Точну форму GameState, версію правил і шлях міграції старих JSONB snapshots. Невідомий формат не можна мовчки трактувати як поточний.
2. Перелік game/system event types, payload, версіонування подій та правила public projection. Сирі payload можуть містити приватні дані; live broadcast і історичний перегляд мають перевіряти видимість для адресата.
3. Контракти `createGameFromRoom`, `saveTransition` і `finishGame`: як сервер доповнює domain events, як фіксуються системні start/finish events, як обробляються events без зміни snapshot та конфлікт `expectedVersion`.
4. У `SERVER_ARCHITECTURE.md` формулювання «feature-specific repository» наприкінці документа треба уточнити: repository **interface** може бути біля feature, PostgreSQL implementation і SQL — у `apps/server/src/db/`.
5. Нормалізацію email у поточному auth application code. Зараз JSON repository шукає email точним порівнянням, тому без синхронізації DB uniqueness і OAuth lookup матимуть різну поведінку.

Майбутню policy видалення історичних guest users, таблиці персональної статистики, індекси для event analytics, persistence player chat і окремий архівний формат фінального поля не фіксуємо в першій міграції. У v1 guest users залишаються, а sessions можна очищати асинхронно; незалежно від запуску cleanup, session expiration/revocation і цілісність історії Game є обов'язковими.
