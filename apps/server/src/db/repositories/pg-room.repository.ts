import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { CreateRoom, RoomRepository, VersionedRules } from "../contracts/room.js";
import type { RulesCodec } from "../contracts/game.js";
import { databaseOperation } from "../errors.js";
import { transaction } from "../transaction.js";
import { fail } from "../repository.errors.js";
import { jsonObject, parseInput, positive, uuid } from "../input.js";
import { roomFromRow, memberFromRow, type RoomRow, type MemberRow } from "../rows.js";

export async function lockRoom(client: PoolClient, id: string): Promise<RoomRow> {
  const result = await client.query<RoomRow>("SELECT * FROM rooms WHERE id = $1 FOR UPDATE", [id]);
  if (!result.rows[0]) fail("NOT_FOUND", "Room not found");
  return result.rows[0];
}
export function requireWaiting(room: RoomRow): void {
  if (room.status !== "waiting") fail("INVALID_STATE_TRANSITION", "Room must be waiting");
}
export function requireHost(room: RoomRow, hostUserId: string): void {
  if (room.host_user_id !== hostUserId) fail("FORBIDDEN", "Room host does not match");
}

export class PgRoomRepository<Rules> implements RoomRepository<Rules> {
  constructor(private readonly pool: Pool, private readonly codec: RulesCodec<Rules>) {}

  createRoom(input: CreateRoom<Rules>) {
    uuid(input.hostUserId); positive(input.capacity);
    if (input.capacity > 32767) fail("INVALID_PERSISTENCE_INPUT", "Capacity is too large");
    positive(input.currentRules.rulesVersion);
    const rules = jsonObject(parseInput(() => this.codec.parseRules(input.currentRules.rulesVersion, input.currentRules.rules)));
    return transaction(this.pool, async (client) => {
      const host = await client.query("SELECT id FROM users WHERE id = $1", [input.hostUserId]);
      if (!host.rowCount) fail("NOT_FOUND", "Host user not found");
      const id = randomUUID();
      const result = await client.query<RoomRow>("INSERT INTO rooms(id, code, name, host_user_id, capacity, current_rules, rules_schema_version) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7) RETURNING *",
        [id, input.code.trim().toUpperCase(), input.name.trim(), input.hostUserId, input.capacity, rules, input.currentRules.rulesVersion]);
      await client.query("INSERT INTO room_members(room_id, user_id) VALUES ($1, $2)", [id, input.hostUserId]);
      return roomFromRow(result.rows[0]!, this.codec);
    });
  }
  findRoomById(id: string) { return this.find("id", uuid(id)); }
  findRoomByCode(code: string) { return this.find("code", code.trim().toUpperCase()); }
  private find(column: "id" | "code", value: string) {
    return databaseOperation(async () => {
      const result = await this.pool.query<RoomRow>("SELECT * FROM rooms WHERE " + column + " = $1", [value]);
      return result.rows[0] ? roomFromRow(result.rows[0], this.codec) : undefined;
    });
  }
  listMembers(roomId: string) {
    uuid(roomId);
    return databaseOperation(async () => {
      const result = await this.pool.query<MemberRow>("SELECT * FROM room_members WHERE room_id = $1 ORDER BY joined_at, user_id", [roomId]);
      return result.rows.map(memberFromRow);
    });
  }
  addMember(roomId: string, userId: string) {
    uuid(roomId); uuid(userId);
    return transaction(this.pool, async (client) => {
      const room = await lockRoom(client, roomId);
      requireWaiting(room);
      const members = await client.query<MemberRow>("SELECT * FROM room_members WHERE room_id = $1", [roomId]);
      const existing = members.rows.find((member) => member.user_id === userId);
      if (existing) return memberFromRow(existing);
      if (members.rows.length >= room.capacity) fail("ROOM_FULL", "Room capacity reached");
      if (!(await client.query("SELECT id FROM users WHERE id = $1", [userId])).rowCount) fail("NOT_FOUND", "User not found");
      const result = await client.query<MemberRow>("INSERT INTO room_members(room_id, user_id) VALUES ($1, $2) RETURNING *", [roomId, userId]);
      await client.query("UPDATE rooms SET version = version + 1 WHERE id = $1", [roomId]);
      return memberFromRow(result.rows[0]!);
    });
  }
  removeMember(roomId: string, userId: string) {
    uuid(roomId); uuid(userId);
    return transaction(this.pool, async (client) => {
      const room = await lockRoom(client, roomId);
      requireWaiting(room);
      if (room.host_user_id === userId) fail("INVALID_STATE_TRANSITION", "Host must be transferred before leaving");
      const removed = await client.query("DELETE FROM room_members WHERE room_id = $1 AND user_id = $2", [roomId, userId]);
      if (removed.rowCount) await client.query("UPDATE rooms SET version = version + 1 WHERE id = $1", [roomId]);
    });
  }
  setReady(roomId: string, userId: string, ready: boolean) {
    uuid(roomId); uuid(userId);
    return transaction(this.pool, async (client) => {
      const room = await lockRoom(client, roomId);
      requireWaiting(room);
      const current = await client.query<MemberRow>("SELECT * FROM room_members WHERE room_id = $1 AND user_id = $2", [roomId, userId]);
      if (!current.rows[0]) fail("NOT_FOUND", "Room member not found");
      if (current.rows[0].ready === ready) return memberFromRow(current.rows[0]);
      const result = await client.query<MemberRow>("UPDATE room_members SET ready = $3 WHERE room_id = $1 AND user_id = $2 RETURNING *", [roomId, userId, ready]);
      await client.query("UPDATE rooms SET version = version + 1 WHERE id = $1", [roomId]);
      return memberFromRow(result.rows[0]!);
    });
  }
  updateRoomRules(roomId: string, hostUserId: string, expectedVersion: number, rules: VersionedRules<Rules>) {
    uuid(roomId); uuid(hostUserId); positive(expectedVersion); positive(rules.rulesVersion);
    const payload = jsonObject(parseInput(() => this.codec.parseRules(rules.rulesVersion, rules.rules)));
    return transaction(this.pool, async (client) => {
      const room = await lockRoom(client, roomId);
      requireWaiting(room); requireHost(room, hostUserId);
      if (room.version !== expectedVersion) fail("CONCURRENCY_CONFLICT", "Room version is stale");
      const result = await client.query<RoomRow>("UPDATE rooms SET current_rules = $2::jsonb, rules_schema_version = $3, version = version + 1 WHERE id = $1 RETURNING *", [roomId, payload, rules.rulesVersion]);
      await client.query("UPDATE room_members SET ready = false WHERE room_id = $1", [roomId]);
      return roomFromRow(result.rows[0]!, this.codec);
    });
  }
  closeRoom(roomId: string, hostUserId: string) {
    uuid(roomId); uuid(hostUserId);
    return transaction(this.pool, async (client) => {
      const room = await lockRoom(client, roomId);
      requireHost(room, hostUserId);
      if (room.status === "closed") return roomFromRow(room, this.codec);
      requireWaiting(room);
      const result = await client.query<RoomRow>("UPDATE rooms SET status = 'closed', version = version + 1 WHERE id = $1 RETURNING *", [roomId]);
      return roomFromRow(result.rows[0]!, this.codec);
    });
  }
  transferHost(roomId: string, hostUserId: string, nextHostUserId: string) {
    uuid(roomId); uuid(hostUserId); uuid(nextHostUserId);
    return transaction(this.pool, async (client) => {
      const room = await lockRoom(client, roomId);
      requireWaiting(room); requireHost(room, hostUserId);
      if (!(await client.query("SELECT 1 FROM room_members WHERE room_id = $1 AND user_id = $2", [roomId, nextHostUserId])).rowCount) fail("NOT_FOUND", "New host must be a room member");
      const result = await client.query<RoomRow>("UPDATE rooms SET host_user_id = $2, version = version + 1 WHERE id = $1 RETURNING *", [roomId, nextHostUserId]);
      return roomFromRow(result.rows[0]!, this.codec);
    });
  }
}
