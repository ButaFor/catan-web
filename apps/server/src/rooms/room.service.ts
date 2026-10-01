import { randomBytes } from "node:crypto";
import type { AuthenticatedUser } from "../auth/auth.types.js";
import type { VersionedRules } from "../db/contracts/room.js";
import { RepositoryError } from "../db/repository.errors.js";
import type {
  RoomDetails,
  RoomRepositoryPort,
  RoomRules,
} from "./room.types.js";

export class RoomService {
  public constructor(private readonly repository: RoomRepositoryPort) {}

  public async create(
    authenticated: AuthenticatedUser,
    name: string,
    capacity: number,
  ): Promise<RoomDetails> {
    const room = await this.repository.createRoom({
      code: await this.createUniqueCode(),
      name,
      hostUserId: authenticated.user.id,
      capacity,
      currentRules: emptyRules(),
    });
    return this.details(room.id);
  }

  public async details(roomId: string): Promise<RoomDetails> {
    const room = await this.repository.findRoomById(roomId);
    if (!room) {
      throw new RepositoryError("NOT_FOUND", "Room not found");
    }
    return { room, members: await this.repository.listMembers(roomId) };
  }

  public async join(
    authenticated: AuthenticatedUser,
    roomId: string,
  ): Promise<RoomDetails> {
    await this.repository.addMember(roomId, authenticated.user.id);
    return this.details(roomId);
  }

  public async leave(
    authenticated: AuthenticatedUser,
    roomId: string,
  ): Promise<void> {
    await this.repository.removeMember(roomId, authenticated.user.id);
  }

  public async setReady(
    authenticated: AuthenticatedUser,
    roomId: string,
    ready: boolean,
  ): Promise<RoomDetails> {
    await this.repository.setReady(roomId, authenticated.user.id, ready);
    return this.details(roomId);
  }

  public async updateRules(
    authenticated: AuthenticatedUser,
    roomId: string,
    expectedVersion: number,
    rules: VersionedRules<RoomRules>,
  ): Promise<RoomDetails> {
    await this.repository.updateRoomRules(
      roomId,
      authenticated.user.id,
      expectedVersion,
      rules,
    );
    return this.details(roomId);
  }

  public async transferHost(
    authenticated: AuthenticatedUser,
    roomId: string,
    nextHostUserId: string,
  ): Promise<RoomDetails> {
    await this.repository.transferHost(
      roomId,
      authenticated.user.id,
      nextHostUserId,
    );
    return this.details(roomId);
  }

  public async close(
    authenticated: AuthenticatedUser,
    roomId: string,
  ): Promise<RoomDetails> {
    await this.repository.closeRoom(roomId, authenticated.user.id);
    return this.details(roomId);
  }

  private async createUniqueCode(): Promise<string> {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const code = randomBytes(3).toString("hex").toUpperCase();
      if (!(await this.repository.findRoomByCode(code))) return code;
    }
    throw new RepositoryError(
      "ROOM_CODE_TAKEN",
      "Could not allocate a unique room code",
    );
  }
}

function emptyRules(): VersionedRules<RoomRules> {
  return { rulesVersion: 1, rules: {} };
}
