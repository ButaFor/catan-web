import type { Room, VersionedRules } from "./room.js";

export type GameEventInput = {
  type: string; actorPlayerId: string | null; payloadSchemaVersion: number; payload: unknown;
} & ({ audience: "public" | "server"; recipientPlayerId?: never }
  | { audience: "player"; recipientPlayerId: string });
export type StoredGameEvent = GameEventInput & {
  id: string; gameId: string; sequenceNumber: number; gameVersion: number; createdAt: string;
};
export type GamePlayer = { id: string; userId: string; color: string; turnOrder: number };
export type VersionedState<State> = { schemaVersion: number; state: State };
export type StoredGame<State, Rules> = {
  id: string; roomId: string; status: "created" | "active" | "finished";
  version: number; stateSchemaVersion: number; currentState: State;
  rulesSnapshot: VersionedRules<Rules>; createdAt: string; finishedAt: string | null;
};
export type GameSummary = { id: string; roomId: string; status: StoredGame<never, never>["status"]; createdAt: string; finishedAt: string | null };
export type SavedTransition<State, Rules> = { game: StoredGame<State, Rules>; events: StoredGameEvent[] };
export type StartGame<State> = {
  id: string; roomId: string; hostUserId: string; expectedRoomVersion: number;
  initialState: VersionedState<State>; players: GamePlayer[]; events: GameEventInput[];
};
export type FinishResult<State, Rules> = SavedTransition<State, Rules> & {
  kind: "finished" | "alreadyFinished"; room: Room<Rules>;
};

// Parsers are supplied by the game/server owners. There is deliberately no permissive default.
export interface RulesCodec<Rules> {
  parseRules(version: number, value: unknown): Rules;
}
export interface GamePersistenceCodec<State, Rules> extends RulesCodec<Rules> {
  parseState(version: number, value: unknown): State;
  parseEvent(event: GameEventInput): GameEventInput;
  parseSystemEvent(event: GameEventInput): GameEventInput;
}
export interface GameRepository<State, Rules> {
  createGameFromRoom(input: StartGame<State>): Promise<SavedTransition<State, Rules> & { room: Room<Rules> }>;
  findGameById(id: string): Promise<StoredGame<State, Rules> | undefined>;
  findOpenGameForRoom(roomId: string): Promise<StoredGame<State, Rules> | undefined>;
  listGamesForRoom(roomId: string, limit?: number): Promise<GameSummary[]>;
  listPlayers(gameId: string): Promise<GamePlayer[]>;
  loadCurrentState(gameId: string): Promise<(VersionedState<State> & { version: number }) | undefined>;
  saveTransition(gameId: string, expectedVersion: number, state: VersionedState<State>, events: GameEventInput[]): Promise<SavedTransition<State, Rules>>;
  appendSystemEvents(gameId: string, expectedVersion: number, events: GameEventInput[]): Promise<SavedTransition<State, Rules>>;
  finishGame(gameId: string, expectedVersion: number, state: VersionedState<State>, events: GameEventInput[]): Promise<FinishResult<State, Rules>>;
  listEvents(gameId: string, afterSequence?: number, limit?: number): Promise<StoredGameEvent[]>;
}
