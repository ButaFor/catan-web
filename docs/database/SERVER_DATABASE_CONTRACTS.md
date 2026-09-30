# Catan Web — контракти між сервером і базою даних

Статус: спільні архітектурні домовленості та письмові відповіді з боку БД на поточний SERVER_DATABASE_ALIGNMENT.md. Коміт 975c1a7 у гілці yur25 підтверджує перелічені в розділі 1 концептуальні рішення. Нові application contracts у розділі 5 ще потребують підтвердження крудільщиком та реалізації в коді; документ не видає їх за вже реалізовані.

Технічні рішення щодо зберігання, цілісності й транзакцій залишаються в [DATABASE_ARCHITECTURE.md](DATABASE_ARCHITECTURE.md).

---

## 1. Вимоги, за якими узгоджено серверну архітектуру

Нижче збережено повний перелік причин і вимог із початкового документа. Крудільщик відобразив основні пункти в `SERVER_ARCHITECTURE.md` комітом `975c1a7`. Цей коміт змінив документацію, а не реалізував PostgreSQL repositories чи application contracts. Відповіді на поточні питання наведено в розділі 5.

### 1.1. `game_events` більше не optional

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

### 1.2. Room має зв'язок `1:N` з Game

У серверній архітектурі вже зафіксовано:

```text
ROOM 1:N GAME
```

Room не є одним Game.

Room переживає завершення Game і підтримує rematch.

### 1.3. Room не має статусу `finished`

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

### 1.4. Потрібен `rules_snapshot` у Game

Room зберігає налаштування для наступної гри.

При старті Game вони копіюються в immutable snapshot конкретного Game.

Причина: після rematch правила можуть змінитися, але стара гра повинна залишатися історично коректною.

### 1.5. GameState — JSONB snapshot

Крудільщик погодився на нашу модель.

У серверній архітектурі вже закріплено:

```text
games.current_state JSONB
```

Це актуальний persistence snapshot GameState.

Не робимо повний event sourcing.

### 1.6. State і Event зберігаються однією транзакцією

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

### 1.7. Guest залишається User

Поточний auth підхід правильний:

```text
Guest -> User(isGuest=true) -> Session
```

Не потрібно робити окрему сутність guest у БД.

Але downstream code повинен пам'ятати:

- guest може грати;
- guest може бути `game_player`;
- guest не отримує account statistics/history.

### 1.8. `game_sessions` краще перейменувати на `games` на persistence-рівні

У server runtime може існувати `GameSession` як клас/об'єкт.

У серверній архітектурі persistent таблицю вже названо:

```text
games
```

Причина: вже є `sessions` для auth, а `game_sessions` створює зайву термінологічну плутанину.

### 1.9. Repository responsibilities треба залишити чіткими

Application services не повинні містити SQL.

PostgreSQL repositories не повинні містити game rules.

`packages/game` не повинна знати про persistence.

Цей пункт у поточній архітектурі вже правильний — його треба зберегти.

### 1.10. Public serializer не повинен напряму використовувати DB rows

Поточне правило крудільщика правильне і залишається:

```text
Database Row != Public DTO
```

Особливо важливо для GameState через hidden/private data.

Server має формувати public projection окремо.

---

## 2. Що крудільщику не потрібно зараз реалізовувати

Поки не треба самостійно фіксувати:

- остаточну фізичну схему `games`;
- остаточну структуру `game_events.payload`;
- індекси для event analytics;
- фінальну схему match history;
- статистику користувачів;
- retention policy для guests;
- persistence player chat;
- SQL-запити для всієї game частини.

Серверний architecture document уже синхронізовано на концептуальному рівні. Перед фізичним проєктуванням ще потрібно підтвердити application contracts із розділу 5.

---

## 3. Попередній expected repository API

Це початковий перелік операцій; семантику результатів і помилок уточнює розділ 5.

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

## 4. Поточний стан узгодження та наступний етап

Коміт `975c1a7` у `yur25` зафіксував у серверній архітектурі `ROOM 1:N GAME`, три статуси Room, `rules_snapshot`, `games.current_state JSONB`, обов'язкові `game_events`, атомарний `saveTransition` і optimistic concurrency. Це узгодження **архітектурного документа**, а не підтвердження готових application contracts або PostgreSQL-коду.

Перед фінальним фізичним дизайном DB side та крудільщик мають звірити application contracts із розділу 5 з реалізацією `rooms`, `games` і `packages/game`. Це письмові відповіді з боку БД, а не твердження, що крудільщик уже реалізував або окремо підтвердив кожен контракт.

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

## 5. Відповіді на поточні питання server/database boundary

Нижче — конкретний контракт, який DB side пропонує крудільщику для підтвердження. Приклади типів задають семантику межі модулів; вони ще не є готовими TypeScript exports. `packages/game/src/index.ts` і `packages/shared/src/index.ts` наразі порожні, тому точні вкладені типи Catan треба додати до реалізації `games`.

### 5.1. Результат ігрової команди

Сервер автентифікує `userId`, перевіряє його membership у Game і визначає `gamePlayerId`. До `packages/game` передається валідована команда з `actorPlayerId = gamePlayerId`, а не session, cookie чи database row. Клієнт не може сам призначити actor. Системні команди формує тільки сервер; для них actor може бути NULL.

```ts
type GameCommand = {
  type: GameCommandType;
  actorPlayerId: string | null;
  payload: CommandPayload;
};

type DomainEvent = {
  type: DomainEventType;
  actorPlayerId: string | null;
  payload: EventPayload;
  audience: "public" | "player" | "server";
  recipientPlayerId?: string;
};

type GameCommandResult =
  | { kind: "applied"; state: GameState; events: [DomainEvent, ...DomainEvent[]] }
  | { kind: "unchanged"; state: GameState; events: [] }
  | { kind: "rejected"; error: { code: DomainErrorCode; details?: unknown } };
```

`type + payload` для commands і domain events є discriminated unions із Zod-валідацією, а не довільним JSON. Для `audience: "player"` обов'язковий `recipientPlayerId`. Одна команда може породити кілька подій. `applied` означає реальну зміну state й хоча б одну подію; `unchanged` дозволений лише для явно ідемпотентної команди, не записує transition і не збільшує version. Некоректний хід повертає `rejected`, а не успішний `unchanged`. Очікувані domain errors не маскуються exception від PostgreSQL.

`packages/game` не додає event id, sequence number чи timestamp. Сервер робить це на persistence boundary. Якщо правило потребує часу або випадковості, сервер надає контрольований вхід; клієнт не визначає результат кубиків, а чиста функція гри не читає БД чи Socket.IO.

### 5.2. GameState і rules snapshot

`packages/game` є власником повного `GameState` та Zod-схем для його версій. Мінімальна валідована форма на межі модулів містить `phase`, `board`, `players`, `turn` (може бути NULL до першого ходу) і `bank`; точні вкладені типи та приховані поля визначаються правилами гри. Весь state має бути JSON-серіалізованим і повністю валідованим, а не `Record<string, unknown>` із перевіркою тільки верхнього рівня.

```ts
type VersionedState = { schemaVersion: number; state: GameState };
type VersionedRules = { rulesVersion: number; rules: GameRules };
```

`games.state_schema_version` відповідає `VersionedState.schemaVersion`; `games.version` лишається окремим лічильником конкурентних переходів. `rooms.current_rules` і `games.rules_snapshot` користуються одним `VersionedRules` contract. При start сервер копіює валідовані rules у snapshot; наступні зміни Room його не змінюють. Зміна Room rules дозволена лише в `waiting` і лише host.

При читанні сервер викликає версійний parser із `packages/game` до передачі state в game logic. Невідома версія state або rules дає контрольовану `UNSUPPORTED_PERSISTED_VERSION`, забороняє хід і не підставляє default. Для нового несумісного формату `packages/game` надає явну функцію міграції `vN → vN+1` або окрему міграцію даних; у v1 старих форматів немає. Точні `BoardState`, `PlayerState`, `TurnState`, `BankState` і опції rules потрібно визначити з реалізацією правил, а не винаходити на стороні БД.

### 5.3. Room і Game lifecycle

Start може ініціювати тільки host Room після авторизації. Передумови: Room у `waiting`, немає відкритої Game, склад учасників відповідає rules/capacity, усі учасники нового матчу готові. Guest може бути host або player, якщо він авторизований як локальний User. Application service перевіряє ці умови; repository гарантує цілісність при одночасних запитах.

У v1 `created` — короткий стан створення всередині start operation: на успішному commit нова Game вже `active`, Room уже `active`, а `GAME_STARTED` записаний. Окрему довготривалу `created` Game клієнту не показуємо. Обмеження БД все одно враховує `created`, щоб майбутній двоетапний запуск не створив дві відкриті Games.

`finishGame` викликається тільки з валідного результату game logic, який завершує матч. Він записує фінальний snapshot, `GAME_FINISHED` (разом з іншими подіями цього переходу), переводить Game у `finished`, а Room — у `waiting` в одній операції. Membership кімнати зберігається, ready state скидається для наступного матчу. Room rules можна змінити після finish, доки Room у `waiting`; активну Room не закриваємо і rules не змінюємо. Закриття під час матчу повертає `INVALID_STATE_TRANSITION`.

Клієнти отримують нову публічну Room/Game проєкцію й події лише після commit. Повторний start/rematch, коли вже є відкрита Game, повертає `GAME_ALREADY_OPEN` (409) та не створює другу. Повторний finish тієї самої Game повертає вже збережений фінальний результат без другого `GAME_FINISHED` і без збільшення version. Rematch — це start нової Game в тій самій Room після finish, а не нова Room.

### 5.4. Application-facing repository interfaces

Інтерфейси можуть лежати біля `rooms`, `games`, `auth`; PostgreSQL implementations і SQL залишаються в `apps/server/src/db/`. Services бачать внутрішні application types у camelCase, а не database rows. Для `find*` відсутність означає `undefined` (як у поточному `AuthRepository`), для `list*` — порожній масив. Mutation за відсутнього target повертає typed `NOT_FOUND` error, а не успіх із порожнім значенням.

```ts
type StoredGame = {
  id: string;
  roomId: string;
  status: "created" | "active" | "finished";
  version: number;
  stateSchemaVersion: number;
  currentState: GameState;
  rulesSnapshot: VersionedRules;
};

type StoredGameEvent = {
  id: string;
  gameId: string;
  sequenceNumber: number;
  type: string;
  actorPlayerId: string | null;
  payloadSchemaVersion: number;
  payload: EventPayload;
  createdAt: string;
};

type SavedTransition = { game: StoredGame; events: StoredGameEvent[] };
```

`createGameFromRoom` приймає перевірений стартовий склад, snapshot правил та початковий state і повертає Room, Game та фактично збережені start events. `findOpenGameForRoom` повертає `StoredGame | undefined`; `listGamesForRoom` повертає summaries без прихованого state. `loadCurrentState` повертає версійований state із concurrency version. `saveTransition` повертає `SavedTransition`. `finishGame` є окремою атомарною application operation з результатом `finished` або `alreadyFinished`, а не другим незалежним записом після `saveTransition`.

Для системної події без зміни snapshot (наприклад, disconnect) передбачаємо окрему `appendSystemEvents(gameId, expectedVersion, events[])`: вона записує події з новими sequence numbers і збільшує concurrency version на один, хоча `currentState` лишається тим самим. `saveTransition` приймає тільки зміну state з непорожнім `events[]`. Точні назви методів можуть змінитися, але ці success/error semantics мають зберегтися в mock і PostgreSQL implementations.

### 5.5. Результат `saveTransition`

```text
saveTransition(gameId, expectedVersion, newState, events[])
  → { game: StoredGame з новою version, events: фактично збережені StoredGameEvent[] }
  | NOT_FOUND | INVALID_STATE_TRANSITION | CONCURRENCY_CONFLICT | DATABASE_UNAVAILABLE
```

Для зміни GameState `events[]` містить щонайменше одну подію. Успіх означає commit snapshot і **всіх** events; відповідь повертає нову version, state schema version і присвоєні id/sequence/timestamps. Порожні events або `unchanged` не передаються в `saveTransition`. Застаріла `expectedVersion` дає `CONCURRENCY_CONFLICT` без запису й без автоматичного повторення команди. `finishGame` застосовує ті самі вимоги до state/events і додатково синхронізує статуси Game/Room; окремий виклик `saveTransition` перед ним не потрібний.

### 5.6. Domain, stored і public events

```text
DomainEvent (результат packages/game або server system action)
  → StoredGameEvent (повний факт + persistence metadata)
  → projectEvent(storedEvent, viewer): PublicEventV1[]
```

Класи видимості: `public` — спільний факт для всіх учасників; `player` — приватні деталі лише для конкретного гравця; `server` — не видається клієнту. Наприклад, `ROAD_BUILT` має публічне розташування, а в `RESOURCES_DISTRIBUTED` точні ресурси гравця можуть бути приватними. Один результат гри може дати публічний summary event і окремі player events для приватних деталей. Server serializer остаточно визначає видимість; сам `audience` у domain event не дозволяє віддати сирий payload.

`PublicEventV1` містить `contractVersion: 1`, `gameId`, публічний `type`, `occurredAt`, безпечний `payload` і, коли доречно, публічного actor. Воно не містить DB row, сирий JSONB, приховані значення чи внутрішній `sequenceNumber`. Для історії й live broadcast використовується одна функція проєкції та одна політика видимості; server-only event дає порожній масив. Порядок history сервер отримує з `sequenceNumber` внутрішньо. Після завершення матчу приватні деталі не стають публічними автоматично. Несумісна зміна DTO підвищує `contractVersion` і має узгоджуватися з клієнтом у `packages/shared`.

### 5.7. Auth application rules

Єдина функція `normalizeEmail(input) = input.trim().toLowerCase()` застосовується в application layer до email перед записом, lookup, OAuth linking і майбутніми registration/login by email. Repository також приймає нормалізоване значення й гарантує унікальність; поточний JSON repository треба привести до тієї самої поведінки до заміни на PostgreSQL. Username залишається case-insensitive, як у чинному `findUserByUsername`.

OAuth account спочатку шукається за `(provider, providerAccountId)`. Якщо його немає, link за normalized email дозволений лише для перевіреного provider email та existing user із перевіреним email; інакше потрібне явне account linking після входу в обидва акаунти. Якщо normalized email уже зайнятий несумісним обліковим записом або provider pair прив'язана до іншого User, повертаємо typed `ACCOUNT_CONFLICT` (409), а не створюємо дубль чи тихо переприв'язуємо. Для Google поточний код уже вимагає `email_verified = true`, але ще не нормалізує email.

Відсутня, expired і revoked session однаково дають `undefined` із `findSessionByTokenHash` та зовнішню `AUTHENTICATION_REQUIRED` (401), без розкриття причини клієнту. Внутрішні метрики можуть розрізняти причини. `revokeSession` для вже відкликаної/відсутньої session є ідемпотентною. Password hash і session token hash не входять до public DTO.

### 5.8. Помилки між `db` та server

Repository повертає typed application errors; SQLSTATE, назви constraints і тексти PostgreSQL не виходять за межі `db`. Для read `find*` відсутність — `undefined`, а для mutation — помилка `NOT_FOUND`. Очікувані конфлікти мають стабільний `code`; transport мапить його однаково для HTTP і Socket.IO acknowledgement.

| Application code | Коли виникає | HTTP |
| --- | --- | --- |
| `NOT_FOUND` | Немає Room/Game/цілі mutation або її не можна бачити. | 404 |
| `AUTHENTICATION_REQUIRED` / `FORBIDDEN` | Немає дійсної session / немає права на операцію. | 401 / 403 |
| `INVALID_STATE_TRANSITION`, `GAME_ALREADY_OPEN` | Статус Room/Game не дозволяє дію. | 409 |
| `CONCURRENCY_CONFLICT` | Застаріла `expectedVersion`. | 409 |
| `ACCOUNT_CONFLICT`, `USERNAME_TAKEN` | Відомий конфлікт унікальності auth. | 409 |
| `INVALID_GAME_COMMAND` | Команда валідна за формою, але порушує правило гри. | 422 |
| `UNSUPPORTED_PERSISTED_VERSION`, `DATABASE_UNAVAILABLE` | Сервер не може безпечно прочитати state або БД недоступна. | 503 |
| `INTERNAL_SERVER_ERROR` | Невідома constraint failure, зіпсовані дані або інша неочікувана помилка. | 500 |

Відоме порушення constraint мапиться в конкретний application conflict; невідоме не стає автоматично 409. `CONCURRENCY_CONFLICT` не перетворюється на 500. Клієнт отримує безпечний `{ code, message }`, сервер логує технічну причину. Поточний auth error handler уже має частину цих кодів; решта — цільовий контракт для нових `rooms`/`games` і PostgreSQL repositories.

## 6. Стан погодження

- **Підтверджено в `yur25` (`975c1a7`):** межі модулів, Room 1:N Game, три статуси Room, rules snapshot, JSONB GameState, обов'язкові events, атомарний transition та optimistic concurrency на рівні архітектури.
- **Відповідь DB side для перевірки крудільщиком:** усі пункти розділу 5, особливо типи результату `packages/game`, `created` у v1, event-only operation, public event DTO та error codes.
- **Перед реалізацією:** крудільщик має підтвердити або скоригувати ці application contracts у своїй архітектурі та типах `rooms`/`games`/`packages/game`; DB side після цього проєктує фізичну схему й repositories. Це не вимагає вигадувати повні Catan types до реалізації правил.
