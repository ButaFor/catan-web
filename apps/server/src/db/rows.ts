import type { User, OAuthAccount, Session } from "./contracts/auth.js";
import type { Room, RoomMember } from "./contracts/room.js";
import type { RulesCodec, GamePersistenceCodec, StoredGame, StoredGameEvent, GameEventInput } from "./contracts/game.js";
import { parseStored } from "./input.js";

export type UserRow = { id: string; display_name: string; is_guest: boolean; username: string | null; email: string | null; email_verified: boolean; password_hash: string | null; avatar_url: string | null; created_at: Date };
export type OAuthRow = { id: string; user_id: string; provider: OAuthAccount["provider"]; provider_account_id: string; created_at: Date };
export type SessionRow = { id: string; user_id: string; token_hash: string; created_at: Date; expires_at: Date; revoked_at: Date | null };
export type RoomRow = { id: string; code: string; name: string; host_user_id: string; status: Room<never>["status"]; capacity: number; version: number; current_rules: unknown; rules_schema_version: number; created_at: Date };
export type MemberRow = { room_id: string; user_id: string; ready: boolean; joined_at: Date };
export type GameRow = { id: string; room_id: string; status: StoredGame<never, never>["status"]; version: number; current_state: unknown; state_schema_version: number; rules_snapshot: unknown; rules_schema_version: number; last_sequence_number: number; created_at: Date; finished_at: Date | null };
export type EventRow = { id: string; game_id: string; sequence_number: number; game_version: number; event_type: string; actor_player_id: string | null; audience: GameEventInput["audience"]; recipient_player_id: string | null; payload: unknown; payload_schema_version: number; created_at: Date };

export const userFromRow = (r: UserRow): User => ({
  id: r.id, displayName: r.display_name, isGuest: r.is_guest, createdAt: r.created_at.toISOString(),
  ...(r.username !== null ? { username: r.username } : {}),
  ...(r.email !== null ? { email: r.email, emailVerified: r.email_verified } : {}),
  ...(r.password_hash !== null ? { passwordHash: r.password_hash } : {}),
  ...(r.avatar_url !== null ? { avatarUrl: r.avatar_url } : {}),
});
export const oauthFromRow = (r: OAuthRow): OAuthAccount => ({ id: r.id, userId: r.user_id, provider: r.provider, providerAccountId: r.provider_account_id, createdAt: r.created_at.toISOString() });
export const sessionFromRow = (r: SessionRow): Session => ({
  id: r.id, userId: r.user_id, tokenHash: r.token_hash, createdAt: r.created_at.toISOString(), expiresAt: r.expires_at.toISOString(),
  ...(r.revoked_at ? { revokedAt: r.revoked_at.toISOString() } : {}),
});
export const memberFromRow = (r: MemberRow): RoomMember => ({ roomId: r.room_id, userId: r.user_id, ready: r.ready, joinedAt: r.joined_at.toISOString() });
export const roomFromRow = <Rules>(r: RoomRow, codec: RulesCodec<Rules>): Room<Rules> => ({
  id: r.id, code: r.code, name: r.name, hostUserId: r.host_user_id, status: r.status,
  capacity: r.capacity, version: r.version, createdAt: r.created_at.toISOString(),
  currentRules: { rulesVersion: r.rules_schema_version, rules: parseStored(() => codec.parseRules(r.rules_schema_version, r.current_rules)) },
});
export const gameFromRow = <State, Rules>(r: GameRow, codec: GamePersistenceCodec<State, Rules>): StoredGame<State, Rules> => ({
  id: r.id, roomId: r.room_id, status: r.status, version: r.version, stateSchemaVersion: r.state_schema_version,
  currentState: parseStored(() => codec.parseState(r.state_schema_version, r.current_state)),
  rulesSnapshot: { rulesVersion: r.rules_schema_version, rules: parseStored(() => codec.parseRules(r.rules_schema_version, r.rules_snapshot)) },
  createdAt: r.created_at.toISOString(), finishedAt: r.finished_at?.toISOString() ?? null,
});
export const eventFromRow = (r: EventRow): StoredGameEvent => ({
  id: r.id, gameId: r.game_id, sequenceNumber: r.sequence_number, gameVersion: r.game_version,
  type: r.event_type, actorPlayerId: r.actor_player_id, payloadSchemaVersion: r.payload_schema_version, payload: r.payload,
  createdAt: r.created_at.toISOString(),
  ...(r.audience === "player" ? { audience: "player", recipientPlayerId: r.recipient_player_id! } : { audience: r.audience }),
});
