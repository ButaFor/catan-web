import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { Pool, PoolClient } from "pg";
import type { GameEventInput, GamePersistenceCodec, GamePlayer, GameRepository, StartGame, VersionedState } from "../contracts/game.js";
import { databaseOperation } from "../errors.js";
import { jsonObject, pageLimit, parseInput, parseStored, positive, uuid } from "../input.js";
import { fail } from "../repository.errors.js";
import { eventFromRow, gameFromRow, roomFromRow, type EventRow, type GameRow, type MemberRow, type RoomRow } from "../rows.js";
import { transaction } from "../transaction.js";
import { lockRoom, requireHost, requireWaiting } from "./pg-room.repository.js";

export class PgGameRepository<State, Rules> implements GameRepository<State, Rules> {
  constructor(private readonly pool: Pool, private readonly codec: GamePersistenceCodec<State, Rules>) {}

  private state(input: VersionedState<State>) {
    positive(input.schemaVersion);
    return jsonObject(parseInput(() => this.codec.parseState(input.schemaVersion, input.state)));
  }

  private events(input: GameEventInput[], lifecycle?: "GAME_STARTED" | "GAME_FINISHED", system = false) {
    if (input.length === 0) fail("INVALID_PERSISTENCE_INPUT", "Event batch must not be empty");
    const events = input.map((event) => {
      const parsed = parseInput(() => system ? this.codec.parseSystemEvent(event) : this.codec.parseEvent(event));
      positive(parsed.payloadSchemaVersion);
      if (!/^[A-Z][A-Z0-9_]*$/.test(parsed.type)) fail("INVALID_PERSISTENCE_INPUT", "Invalid event type");
      if (parsed.actorPlayerId !== null) uuid(parsed.actorPlayerId);
      if (parsed.audience === "player") uuid(parsed.recipientPlayerId);
      else if (!["public", "server"].includes(parsed.audience) || parsed.recipientPlayerId !== undefined) {
        fail("INVALID_PERSISTENCE_INPUT", "Invalid event audience");
      }
      return { ...parsed, payload: JSON.parse(jsonObject(parsed.payload)) as unknown };
    });
    const lifecycleEvents = events.filter((event) => ["GAME_STARTED", "GAME_FINISHED"].includes(event.type));
    if (lifecycle ? lifecycleEvents.length !== 1 || lifecycleEvents[0]!.type !== lifecycle : lifecycleEvents.length !== 0) {
      fail("INVALID_PERSISTENCE_INPUT", "Lifecycle event must be supplied exactly once by the start/finish caller");
    }
    return events;
  }

  private async lockGame(client: PoolClient, id: string) {
    const result = await client.query<GameRow>("SELECT * FROM games WHERE id = $1 FOR UPDATE", [id]);
    if (!result.rows[0]) fail("NOT_FOUND", "Game not found");
    return result.rows[0];
  }

  private requireActive(game: GameRow, expectedVersion: number) {
    if (game.status !== "active") fail("INVALID_STATE_TRANSITION", "Game must be active");
    if (game.version !== expectedVersion) fail("CONCURRENCY_CONFLICT", "Game version is stale");
    // Validate stored versions before any mutation; unsupported snapshots cannot be overwritten.
    gameFromRow(game, this.codec);
  }

  private requireChanged(game: GameRow, schemaVersion: number, payload: string) {
    if (game.state_schema_version === schemaVersion && isDeepStrictEqual(game.current_state, JSON.parse(payload))) {
      fail("INVALID_STATE_TRANSITION", "Unchanged state must not be persisted as a gameplay transition");
    }
  }

  private readEvent(row: EventRow) {
    const event = eventFromRow(row);
    parseStored(() => this.codec.parseEvent(event));
    return event;
  }

  private async insertEvents(client: PoolClient, game: GameRow, events: GameEventInput[]) {
    const stored = [];
    for (const [index, event] of events.entries()) {
      const result = await client.query<EventRow>(
        "INSERT INTO game_events(id, game_id, sequence_number, game_version, event_type, actor_player_id, audience, recipient_player_id, payload, payload_schema_version) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10) RETURNING *",
        [randomUUID(), game.id, game.last_sequence_number + index + 1, game.version, event.type, event.actorPlayerId,
          event.audience, event.recipientPlayerId ?? null, jsonObject(event.payload), event.payloadSchemaVersion]);
      stored.push(this.readEvent(result.rows[0]!));
    }
    if (events.length) await client.query("UPDATE games SET last_sequence_number = $2 WHERE id = $1", [game.id, game.last_sequence_number + events.length]);
    return stored;
  }

  createGameFromRoom(input: StartGame<State>) {
    uuid(input.id); uuid(input.roomId); uuid(input.hostUserId); positive(input.expectedRoomVersion);
    const state = this.state(input.initialState);
    const events = this.events(input.events, "GAME_STARTED");
    for (const player of input.players) {
      uuid(player.id); uuid(player.userId);
      if (!Number.isInteger(player.turnOrder) || player.turnOrder < 0 || !player.color.trim()) fail("INVALID_PERSISTENCE_INPUT", "Invalid player roster");
    }
    for (const key of ["id", "userId", "color", "turnOrder"] as const) {
      if (new Set(input.players.map((player) => player[key])).size !== input.players.length) fail("INVALID_PERSISTENCE_INPUT", "Duplicate player roster entry");
    }
    return transaction(this.pool, async (client) => {
      const room = await lockRoom(client, input.roomId);
      requireHost(room, input.hostUserId);
      if ((await client.query("SELECT id FROM games WHERE room_id = $1 AND status IN ('created', 'active')", [room.id])).rowCount) fail("GAME_ALREADY_OPEN", "Room already has an open game");
      requireWaiting(room);
      if (room.version !== input.expectedRoomVersion) fail("CONCURRENCY_CONFLICT", "Room version is stale");
      roomFromRow(room, this.codec);
      const members = (await client.query<MemberRow>("SELECT * FROM room_members WHERE room_id = $1", [room.id])).rows;
      if (!members.length || members.length > room.capacity || members.some((member) => !member.ready)
        || members.length !== input.players.length || members.some((member) => !input.players.some((player) => player.userId === member.user_id))) {
        fail("INVALID_STATE_TRANSITION", "All room members must be ready and included in the game roster");
      }
      const result = await client.query<GameRow>(
        "INSERT INTO games(id, room_id, status, rules_snapshot, rules_schema_version, current_state, state_schema_version) VALUES ($1,$2,'active',$3::jsonb,$4,$5::jsonb,$6) RETURNING *",
        [input.id, room.id, jsonObject(room.current_rules), room.rules_schema_version, state, input.initialState.schemaVersion]);
      for (const player of input.players) {
        await client.query("INSERT INTO game_players(id, game_id, user_id, color, turn_order) VALUES ($1,$2,$3,$4,$5)", [player.id, input.id, player.userId, player.color, player.turnOrder]);
      }
      const storedEvents = await this.insertEvents(client, result.rows[0]!, events);
      const updatedRoom = await client.query<RoomRow>("UPDATE rooms SET status = 'active', version = version + 1 WHERE id = $1 RETURNING *", [room.id]);
      return { game: gameFromRow(result.rows[0]!, this.codec), events: storedEvents, room: roomFromRow(updatedRoom.rows[0]!, this.codec) };
    });
  }

  findGameById(id: string) { return this.find("id = $1", uuid(id)); }
  findOpenGameForRoom(roomId: string) { return this.find("room_id = $1 AND status IN ('created', 'active')", uuid(roomId)); }
  private find(predicate: string, value: string) {
    return databaseOperation(async () => {
      const result = await this.pool.query<GameRow>("SELECT * FROM games WHERE " + predicate, [value]);
      return result.rows[0] ? gameFromRow(result.rows[0], this.codec) : undefined;
    });
  }
  listGamesForRoom(roomId: string, limit = 100) {
    uuid(roomId); pageLimit(limit);
    return databaseOperation(async () => {
      const result = await this.pool.query<Pick<GameRow, "id" | "room_id" | "status" | "created_at" | "finished_at">>(
        "SELECT id, room_id, status, created_at, finished_at FROM games WHERE room_id = $1 ORDER BY created_at DESC, id DESC LIMIT $2", [roomId, limit]);
      return result.rows.map((row) => ({ id: row.id, roomId: row.room_id, status: row.status, createdAt: row.created_at.toISOString(), finishedAt: row.finished_at?.toISOString() ?? null }));
    });
  }
  listPlayers(gameId: string) {
    uuid(gameId);
    return databaseOperation(async () => (await this.pool.query<GamePlayer>(
      'SELECT id, user_id AS "userId", color, turn_order AS "turnOrder" FROM game_players WHERE game_id = $1 ORDER BY turn_order', [gameId])).rows);
  }
  async loadCurrentState(gameId: string) {
    const game = await this.findGameById(gameId);
    return game ? { schemaVersion: game.stateSchemaVersion, state: game.currentState, version: game.version } : undefined;
  }

  saveTransition(gameId: string, expectedVersion: number, state: VersionedState<State>, events: GameEventInput[]) {
    uuid(gameId); positive(expectedVersion);
    const payload = this.state(state);
    const parsedEvents = this.events(events);
    return transaction(this.pool, async (client) => {
      const game = await this.lockGame(client, gameId);
      this.requireActive(game, expectedVersion);
      this.requireChanged(game, state.schemaVersion, payload);
      const updated = await client.query<GameRow>("UPDATE games SET current_state = $2::jsonb, state_schema_version = $3, version = version + 1 WHERE id = $1 RETURNING *", [gameId, payload, state.schemaVersion]);
      const storedEvents = await this.insertEvents(client, updated.rows[0]!, parsedEvents);
      return { game: gameFromRow(updated.rows[0]!, this.codec), events: storedEvents };
    });
  }

  appendSystemEvents(gameId: string, expectedVersion: number, events: GameEventInput[]) {
    uuid(gameId); positive(expectedVersion);
    const parsedEvents = this.events(events, undefined, true);
    return transaction(this.pool, async (client) => {
      const game = await this.lockGame(client, gameId);
      this.requireActive(game, expectedVersion);
      const updated = await client.query<GameRow>("UPDATE games SET version = version + 1 WHERE id = $1 RETURNING *", [gameId]);
      const storedEvents = await this.insertEvents(client, updated.rows[0]!, parsedEvents);
      return { game: gameFromRow(updated.rows[0]!, this.codec), events: storedEvents };
    });
  }

  finishGame(gameId: string, expectedVersion: number, state: VersionedState<State>, events: GameEventInput[]) {
    uuid(gameId); positive(expectedVersion);
    return transaction(this.pool, async (client) => {
      const identity = await client.query<{ room_id: string }>("SELECT room_id FROM games WHERE id = $1", [gameId]);
      if (!identity.rows[0]) fail("NOT_FOUND", "Game not found");
      // Every operation that needs both rows acquires room before game, including retries.
      const room = await lockRoom(client, identity.rows[0].room_id);
      const game = await this.lockGame(client, gameId);
      if (game.status === "finished") {
        const stored = await client.query<EventRow>("SELECT * FROM game_events WHERE game_id = $1 AND game_version = $2 ORDER BY sequence_number", [gameId, game.version]);
        return { kind: "alreadyFinished" as const, game: gameFromRow(game, this.codec), room: roomFromRow(room, this.codec), events: stored.rows.map((row) => this.readEvent(row)) };
      }
      this.requireActive(game, expectedVersion);
      const payload = this.state(state);
      this.requireChanged(game, state.schemaVersion, payload);
      const parsedEvents = this.events(events, "GAME_FINISHED");
      // Append before marking finished: the immutable-history guard forbids subsequent updates.
      const transitioned = await client.query<GameRow>("UPDATE games SET current_state = $2::jsonb, state_schema_version = $3, version = version + 1 WHERE id = $1 RETURNING *", [gameId, payload, state.schemaVersion]);
      const storedEvents = await this.insertEvents(client, transitioned.rows[0]!, parsedEvents);
      const finished = await client.query<GameRow>("UPDATE games SET status = 'finished', finished_at = now() WHERE id = $1 RETURNING *", [gameId]);
      const waiting = await client.query<RoomRow>("UPDATE rooms SET status = 'waiting', version = version + 1 WHERE id = $1 RETURNING *", [room.id]);
      await client.query("UPDATE room_members SET ready = false WHERE room_id = $1", [room.id]);
      return { kind: "finished" as const, game: gameFromRow(finished.rows[0]!, this.codec), room: roomFromRow(waiting.rows[0]!, this.codec), events: storedEvents };
    });
  }

  listEvents(gameId: string, afterSequence = 0, limit = 100) {
    uuid(gameId); pageLimit(limit);
    if (!Number.isInteger(afterSequence) || afterSequence < 0 || afterSequence > 2147483647) fail("INVALID_PERSISTENCE_INPUT", "Invalid sequence cursor");
    return databaseOperation(async () => {
      const result = await this.pool.query<EventRow>("SELECT * FROM game_events WHERE game_id = $1 AND sequence_number > $2 ORDER BY sequence_number LIMIT $3", [gameId, afterSequence, limit]);
      return result.rows.map((row) => this.readEvent(row));
    });
  }
}
