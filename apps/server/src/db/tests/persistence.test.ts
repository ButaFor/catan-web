import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, writeFile, unlink, rmdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import type { Pool } from "pg";
import { createPool, migrate, checkDatabase, PgAuthRepository, PgRoomRepository, PgGameRepository, RepositoryError } from "../index.js";
import type { GamePersistenceCodec, GameEventInput, StartGame } from "../index.js";

// Fixtures describe persistence behavior, not Catan rules. Production codecs come from game/server owners.
const rulesSchema = z.object({ target: z.number().int().positive() }).strict();
const stateSchema = z.object({ turn: z.number().int().nonnegative(), secret: z.string() }).strict();
type Rules = z.infer<typeof rulesSchema>;
type State = z.infer<typeof stateSchema>;
const codec: GamePersistenceCodec<State, Rules> = {
  parseRules(version, value) { versionOne(version); return rulesSchema.parse(value); },
  parseState(version, value) { versionOne(version); return stateSchema.parse(value); },
  parseEvent(event) {
    versionOne(event.payloadSchemaVersion);
    z.enum(["GAME_STARTED", "GAME_FINISHED", "TURN_CHANGED", "PLAYER_DISCONNECTED"]).parse(event.type);
    z.object({ note: z.string() }).strict().parse(event.payload);
    return event;
  },
  parseSystemEvent(event) {
    if (event.type !== "PLAYER_DISCONNECTED") throw new Error("Not a system event");
    return this.parseEvent(event);
  },
};
function versionOne(version: number) {
  if (version !== 1) throw new RepositoryError("UNSUPPORTED_PERSISTED_VERSION", "Unsupported fixture version");
}
const event = (type: string, extra: Partial<GameEventInput> = {}): GameEventInput => ({
  type, actorPlayerId: null, audience: "public", payloadSchemaVersion: 1, payload: { note: type }, ...extra,
} as GameEventInput);
const state = (turn: number) => ({ schemaVersion: 1, state: { turn, secret: "private hand" } });
const invoke = <T>(operation: () => T) => Promise.resolve().then(operation);
const testUrl = process.env.TEST_DATABASE_URL;

describe.skipIf(!testUrl)("PostgreSQL persistence (isolated schema)", () => {
  let admin: Pool;
  let pool: Pool;
  let auth: PgAuthRepository;
  let rooms: PgRoomRepository<Rules>;
  let games: PgGameRepository<State, Rules>;
  const schema = "catan_test_" + randomUUID().replaceAll("-", "");
  beforeAll(async () => {
    const url = new URL(testUrl!);
    if (!decodeURIComponent(url.pathname).endsWith("_test")) throw new Error("TEST_DATABASE_URL must name a database ending in _test");
    admin = createPool({ connectionString: testUrl! });
    await admin.query('CREATE SCHEMA "' + schema + '"');
    pool = createPool({ connectionString: testUrl!, options: "-c search_path=" + schema });
    await migrate(pool);
    auth = new PgAuthRepository(pool);
    rooms = new PgRoomRepository(pool, codec);
    games = new PgGameRepository(pool, codec);
  }, 20000);
  afterAll(async () => {
    await pool?.end();
    if (admin) {
      try { await admin.query('DROP SCHEMA IF EXISTS "' + schema + '" CASCADE'); }
      finally { await admin.end(); }
    }
  });

  async function lobby(capacity = 2) {
    const host = await auth.createGuestUser("Host");
    const other = await auth.createGuestUser("Other");
    const room = await rooms.createRoom({ code: randomUUID().slice(0, 8), name: "Test room", hostUserId: host.id, capacity, currentRules: { rulesVersion: 1, rules: { target: 10 } } });
    await rooms.addMember(room.id, other.id);
    return { room, host, other };
  }
  async function readyGame(): Promise<StartGame<State>> {
    const { room, host, other } = await lobby();
    await rooms.setReady(room.id, host.id, true);
    await rooms.setReady(room.id, other.id, true);
    return { id: randomUUID(), roomId: room.id, hostUserId: host.id,
      expectedRoomVersion: (await rooms.findRoomById(room.id))!.version,
      initialState: state(0), events: [event("GAME_STARTED")],
      players: [host, other].map((user, turnOrder) => ({ id: randomUUID(), userId: user.id, color: ["red", "blue"][turnOrder]!, turnOrder })) };
  }

  it("applies migrations once, reports readiness and serializes concurrent runners", async () => {
    await checkDatabase(pool);
    expect(await Promise.all([migrate(pool), migrate(pool)])).toEqual([[], []]);
    expect((await pool.query("SELECT name FROM schema_migrations")).rows).toEqual([{ name: "001_initial.sql" }]);
  });
  it("detects changed migrations and rolls failed DDL back with its ledger", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "catan-migrations-"));
    const initial = path.join(directory, "001_initial.sql");
    const broken = path.join(directory, "002_broken.sql");
    try {
      const sql = await readFile(new URL("../../../migrations/001_initial.sql", import.meta.url), "utf8");
      await writeFile(initial, sql + "\n-- changed\n");
      await expect(migrate(pool, directory)).rejects.toThrow("Applied migration has changed");
      await writeFile(initial, sql);
      await writeFile(broken, "CREATE TABLE rolled_back(id integer); SELECT * FROM table_that_does_not_exist;");
      await expect(migrate(pool, directory)).rejects.toThrow();
      expect((await pool.query("SELECT to_regclass('rolled_back') AS table_name")).rows[0].table_name).toBeNull();
      expect((await pool.query("SELECT count(*)::int AS n FROM schema_migrations")).rows[0].n).toBe(1);
    } finally {
      await unlink(initial).catch(() => {}); await unlink(broken).catch(() => {}); await rmdir(directory);
    }
  });
  it("enforces case-insensitive username uniqueness during concurrent registration", async () => {
    const results = await Promise.allSettled([auth.createPasswordUser("Alice", "hash"), auth.createPasswordUser("alice", "hash")]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.find((result) => result.status === "rejected")).toMatchObject({ reason: { code: "USERNAME_TAKEN" } });
    expect(await auth.findUserByUsername(" ALICE ")).toMatchObject({ isGuest: false, passwordHash: "hash" });
  });
  it("normalizes OAuth email and rolls back users when provider binding conflicts", async () => {
    const user = await auth.createOAuthUser({ displayName: "OAuth", email: " OAuth@Example.COM ", providerAccountId: "google-1" });
    expect(user.email).toBe("oauth@example.com");
    expect((await auth.findUserByEmail(" OAUTH@example.com "))?.id).toBe(user.id);
    await expect(auth.createOAuthUser({ displayName: "Duplicate", email: "another@example.com", providerAccountId: "google-1" })).rejects.toMatchObject({ code: "ACCOUNT_CONFLICT" });
    expect(await auth.findUserByEmail("another@example.com")).toBeUndefined();
    await expect(auth.createOAuthUser({ displayName: "Duplicate", email: "OAUTH@example.com", providerAccountId: "google-2" })).rejects.toMatchObject({ code: "ACCOUNT_CONFLICT" });
    expect(await auth.findOAuthAccount("google", "google-2")).toBeUndefined();
  });
  it("links idempotently and refuses rebinding or linking an unverified user", async () => {
    const user = await auth.createOAuthUser({ displayName: "First", email: "first@example.com", providerAccountId: "first" });
    const other = await auth.createOAuthUser({ displayName: "Second", email: "second@example.com", providerAccountId: "second" });
    await auth.linkOAuthAccount(user.id, "google", "first");
    await expect(auth.linkOAuthAccount(other.id, "google", "first")).rejects.toMatchObject({ code: "ACCOUNT_CONFLICT" });
    const guest = await auth.createGuestUser("Guest");
    await expect(auth.linkOAuthAccount(guest.id, "google", "third")).rejects.toMatchObject({ code: "ACCOUNT_CONFLICT" });
    expect((await auth.findOAuthAccount("google", "first"))?.user.id).toBe(user.id);
  });
  it("filters expired/revoked sessions and cleans sessions without deleting guests", async () => {
    const guest = await auth.createGuestUser("Session guest");
    const base = { userId: guest.id, createdAt: new Date(Date.now() - 120000).toISOString() };
    const expired = await auth.createSession({ ...base, tokenHash: "a".repeat(64), expiresAt: new Date(Date.now() - 60000).toISOString() });
    const active = await auth.createSession({ ...base, tokenHash: "b".repeat(64), expiresAt: new Date(Date.now() + 60000).toISOString() });
    expect(await auth.findSessionByTokenHash(expired.tokenHash)).toBeUndefined();
    expect((await auth.findSessionByTokenHash(active.tokenHash))?.id).toBe(active.id);
    await auth.revokeSession(active.id); await auth.revokeSession(active.id); await auth.revokeSession(randomUUID());
    expect(await auth.findSessionByTokenHash(active.tokenHash)).toBeUndefined();
    expect(await auth.findSessionByTokenHash("c".repeat(64))).toBeUndefined();
    expect(await auth.cleanupExpiredSessions()).toBe(1);
    expect(await auth.findUserById(guest.id)).toBeDefined();
  });
  it("serializes room capacity races and keeps repeated joins idempotent", async () => {
    const { room, host, other } = await lobby(3);
    const third = await auth.createGuestUser("Third"); const fourth = await auth.createGuestUser("Fourth");
    const results = await Promise.allSettled([rooms.addMember(room.id, third.id), rooms.addMember(room.id, fourth.id)]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.find((result) => result.status === "rejected")).toMatchObject({ reason: { code: "ROOM_FULL" } });
    await rooms.addMember(room.id, other.id);
    expect(await rooms.listMembers(room.id)).toHaveLength(3);
    await expect(rooms.removeMember(room.id, host.id)).rejects.toMatchObject({ code: "INVALID_STATE_TRANSITION" });
    await rooms.transferHost(room.id, host.id, other.id);
    await rooms.removeMember(room.id, host.id);
    expect(await rooms.listMembers(room.id)).toHaveLength(2);
  });
  it("protects room rules with host/version checks and resets ready", async () => {
    const { room, host, other } = await lobby();
    await rooms.setReady(room.id, other.id, true);
    const current = (await rooms.findRoomById(room.id))!;
    const rules = { rulesVersion: 1, rules: { target: 12 } };
    await expect(rooms.updateRoomRules(room.id, other.id, current.version, rules)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(rooms.updateRoomRules(room.id, host.id, room.version, rules)).rejects.toMatchObject({ code: "CONCURRENCY_CONFLICT" });
    expect((await rooms.updateRoomRules(room.id, host.id, current.version, rules)).currentRules).toEqual(rules);
    expect((await rooms.listMembers(room.id)).every((member) => !member.ready)).toBe(true);
    expect((await rooms.findRoomByCode(room.code.toLowerCase()))?.id).toBe(room.id);
  });
  it("starts exactly one game during competing starts and preserves frozen roster/rules", async () => {
    const input = await readyGame();
    const results = await Promise.allSettled([games.createGameFromRoom(input), games.createGameFromRoom({ ...input, id: randomUUID() })]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.find((result) => result.status === "rejected")).toMatchObject({ reason: { code: "GAME_ALREADY_OPEN" } });
    const game = (await games.findOpenGameForRoom(input.roomId))!;
    expect(game).toMatchObject({ status: "active", version: 1, rulesSnapshot: { rulesVersion: 1, rules: { target: 10 } } });
    expect(await games.listPlayers(game.id)).toEqual(input.players);
    expect(await games.listEvents(game.id)).toMatchObject([{ type: "GAME_STARTED", sequenceNumber: 1, gameVersion: 1 }]);
    await expect(rooms.closeRoom(input.roomId, input.hostUserId)).rejects.toMatchObject({ code: "INVALID_STATE_TRANSITION" });
    await expect(rooms.setReady(input.roomId, input.hostUserId, false)).rejects.toMatchObject({ code: "INVALID_STATE_TRANSITION" });
  });
  it("rejects stale room input, missing readiness, non-host and mismatched rosters", async () => {
    const input = await readyGame();
    await expect(games.createGameFromRoom({ ...input, expectedRoomVersion: 1 })).rejects.toMatchObject({ code: "CONCURRENCY_CONFLICT" });
    await expect(games.createGameFromRoom({ ...input, hostUserId: input.players[1]!.userId })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(games.createGameFromRoom({ ...input, players: input.players.slice(0, 1) })).rejects.toMatchObject({ code: "INVALID_STATE_TRANSITION" });
    await rooms.setReady(input.roomId, input.hostUserId, false);
    await expect(games.createGameFromRoom({ ...input, expectedRoomVersion: (await rooms.findRoomById(input.roomId))!.version })).rejects.toMatchObject({ code: "INVALID_STATE_TRANSITION" });
    expect(await games.findOpenGameForRoom(input.roomId)).toBeUndefined();
  });
  it("allows one concurrent transition per expected version and records every event in order", async () => {
    const { game } = await games.createGameFromRoom(await readyGame());
    const results = await Promise.allSettled([1, 2].map((turn) => games.saveTransition(game.id, 1, state(turn), [event("TURN_CHANGED"), event("TURN_CHANGED")])));
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.find((result) => result.status === "rejected")).toMatchObject({ reason: { code: "CONCURRENCY_CONFLICT" } });
    const stored = await games.listEvents(game.id);
    expect(stored.map((item) => item.sequenceNumber)).toEqual([1, 2, 3]);
    expect(stored.map((item) => item.gameVersion)).toEqual([1, 2, 2]);
    expect((await games.loadCurrentState(game.id))?.version).toBe(2);
    expect(await games.listEvents(game.id, 1, 1)).toEqual([stored[1]]);
  });
  it("rolls snapshot, version and all events back when a later event has a foreign actor", async () => {
    const input = await readyGame(); const { game } = await games.createGameFromRoom(input);
    const otherInput = await readyGame(); await games.createGameFromRoom(otherInput);
    await expect(games.saveTransition(game.id, 1, state(1), [event("TURN_CHANGED"), event("TURN_CHANGED", { actorPlayerId: otherInput.players[0]!.id })])).rejects.toMatchObject({ code: "INTERNAL_SERVER_ERROR" });
    expect(await games.findGameById(game.id)).toEqual(game);
    expect(await games.listEvents(game.id)).toHaveLength(1);
    const result = await games.saveTransition(game.id, 1, state(1), [event("TURN_CHANGED", { actorPlayerId: input.players[0]!.id, audience: "player", recipientPlayerId: input.players[1]!.id })]);
    expect(result.events[0]).toMatchObject({ sequenceNumber: 2, audience: "player", recipientPlayerId: input.players[1]!.id });
  });
  it("rolls back start and room status when an event cannot be stored", async () => {
    const input = await readyGame();
    await expect(games.createGameFromRoom({ ...input, events: [event("GAME_STARTED", { actorPlayerId: randomUUID() })] })).rejects.toMatchObject({ code: "INTERNAL_SERVER_ERROR" });
    expect(await games.findGameById(input.id)).toBeUndefined();
    expect(await games.listPlayers(input.id)).toEqual([]);
    expect((await rooms.findRoomById(input.roomId))?.status).toBe("waiting");
    await games.createGameFromRoom(input);
  });
  it("refuses empty events, unchanged state and lifecycle events on regular writes", async () => {
    const { game } = await games.createGameFromRoom(await readyGame());
    await expect(invoke(() => games.saveTransition(game.id, 1, state(1), []))).rejects.toMatchObject({ code: "INVALID_PERSISTENCE_INPUT" });
    await expect(games.saveTransition(game.id, 1, state(0), [event("TURN_CHANGED")])).rejects.toMatchObject({ code: "INVALID_STATE_TRANSITION" });
    await expect(invoke(() => games.saveTransition(game.id, 1, state(1), [event("GAME_FINISHED")]))).rejects.toMatchObject({ code: "INVALID_PERSISTENCE_INPUT" });
    expect((await games.findGameById(game.id))?.version).toBe(1);
  });
  it("appends only validated system events without changing snapshot", async () => {
    const { game } = await games.createGameFromRoom(await readyGame());
    await expect(invoke(() => games.appendSystemEvents(game.id, 1, [event("TURN_CHANGED")]))).rejects.toMatchObject({ code: "INVALID_PERSISTENCE_INPUT" });
    const saved = await games.appendSystemEvents(game.id, 1, [event("PLAYER_DISCONNECTED", { audience: "server" })]);
    expect(saved.game.currentState).toEqual(game.currentState);
    expect(saved.game.version).toBe(2);
    expect(saved.events[0]).toMatchObject({ audience: "server", sequenceNumber: 2 });
  });
  it("finishes atomically, retries idempotently, and starts a rematch with new rules", async () => {
    const input = await readyGame(); const { game } = await games.createGameFromRoom(input);
    const finished = await games.finishGame(game.id, 1, state(8), [event("TURN_CHANGED"), event("GAME_FINISHED")]);
    expect(finished).toMatchObject({ kind: "finished", game: { status: "finished", version: 2 }, room: { status: "waiting" } });
    expect((await rooms.listMembers(input.roomId)).every((member) => !member.ready)).toBe(true);
    const retry = await games.finishGame(game.id, 1, state(99), [event("GAME_FINISHED")]);
    expect(retry).toEqual({ ...finished, kind: "alreadyFinished" });
    expect(await games.listEvents(game.id)).toHaveLength(3);
    await rooms.updateRoomRules(input.roomId, input.hostUserId, finished.room.version, { rulesVersion: 1, rules: { target: 12 } });
    for (const player of input.players) await rooms.setReady(input.roomId, player.userId, true);
    const rematch = await games.createGameFromRoom({ ...input, id: randomUUID(), expectedRoomVersion: (await rooms.findRoomById(input.roomId))!.version, players: input.players.map((player) => ({ ...player, id: randomUUID() })) });
    expect(rematch.game.rulesSnapshot.rules.target).toBe(12);
    expect((await games.findGameById(game.id))?.rulesSnapshot.rules.target).toBe(10);
    const lateRetry = await games.finishGame(game.id, 1, state(99), [event("GAME_FINISHED")]);
    expect(lateRetry.room.status).toBe("active");
    expect((await games.findOpenGameForRoom(input.roomId))?.id).toBe(rematch.game.id);
    const summaries = await games.listGamesForRoom(input.roomId);
    expect(summaries).toHaveLength(2);
    expect(summaries.every((summary) => !Object.hasOwn(summary, "currentState"))).toBe(true);
  });
  it("rolls finish back and rejects stale finish without resetting the room", async () => {
    const input = await readyGame(); const { game } = await games.createGameFromRoom(input);
    await expect(games.finishGame(game.id, 2, state(4), [event("GAME_FINISHED")])).rejects.toMatchObject({ code: "CONCURRENCY_CONFLICT" });
    await expect(games.finishGame(game.id, 1, state(4), [event("GAME_FINISHED", { audience: "player", recipientPlayerId: randomUUID() })])).rejects.toMatchObject({ code: "INTERNAL_SERVER_ERROR" });
    expect(await games.findGameById(game.id)).toEqual(game);
    expect((await rooms.findRoomById(input.roomId))?.status).toBe("active");
    expect((await rooms.listMembers(input.roomId)).every((member) => member.ready)).toBe(true);
  });
  it("database constraints enforce immutable rules, finished state and room/game lifecycle", async () => {
    const input = await readyGame(); const { game } = await games.createGameFromRoom(input);
    await expect(pool.query("UPDATE games SET rules_snapshot = '{\"target\":99}' WHERE id = $1", [game.id])).rejects.toMatchObject({ code: "23514" });
    await expect(pool.query("UPDATE rooms SET status = 'waiting' WHERE id = $1", [input.roomId])).rejects.toMatchObject({ code: "23514" });
    await games.finishGame(game.id, 1, state(5), [event("GAME_FINISHED")]);
    await expect(pool.query("UPDATE games SET current_state = '{\"turn\":99}' WHERE id = $1", [game.id])).rejects.toMatchObject({ code: "23514" });
    await expect(games.saveTransition(game.id, 2, state(99), [event("TURN_CHANGED")])).rejects.toMatchObject({ code: "INVALID_STATE_TRANSITION" });
  });
  it("rejects invalid payloads/unknown versions and never overwrites unsupported snapshots", async () => {
    const input = await readyGame();
    await expect(invoke(() => games.createGameFromRoom({ ...input, initialState: { ...state(0), schemaVersion: 99 } }))).rejects.toMatchObject({ code: "UNSUPPORTED_PERSISTED_VERSION" });
    await expect(invoke(() => games.createGameFromRoom({ ...input, events: [event("GAME_STARTED", { payload: { bad: true } })] }))).rejects.toMatchObject({ code: "INVALID_PERSISTENCE_INPUT" });
    await games.createGameFromRoom(input);
    await pool.query("UPDATE games SET state_schema_version = 99 WHERE id = $1", [input.id]);
    await expect(games.loadCurrentState(input.id)).rejects.toMatchObject({ code: "UNSUPPORTED_PERSISTED_VERSION" });
    await expect(games.saveTransition(input.id, 1, state(1), [event("TURN_CHANGED")])).rejects.toMatchObject({ code: "UNSUPPORTED_PERSISTED_VERSION" });
    expect((await pool.query("SELECT version, state_schema_version FROM games WHERE id = $1", [input.id])).rows[0]).toEqual({ version: 1, state_schema_version: 99 });
  });
  it("returns undefined/empty for missing reads and typed NOT_FOUND for mutations", async () => {
    const id = randomUUID();
    expect(await games.findGameById(id)).toBeUndefined();
    expect(await rooms.findRoomById(id)).toBeUndefined();
    expect(await games.listGamesForRoom(id)).toEqual([]);
    await expect(games.saveTransition(id, 1, state(1), [event("TURN_CHANGED")])).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(rooms.addMember(id, randomUUID())).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
