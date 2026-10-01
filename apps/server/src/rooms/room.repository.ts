import { randomUUID } from "node:crypto";
import type {
  CreateRoom,
  Room,
  RoomMember,
  RoomRepository,
  VersionedRules,
} from "../db/contracts/room.js";
import { RepositoryError } from "../db/repository.errors.js";
import type { RoomRules } from "./room.types.js";

export class InMemoryRoomRepository implements RoomRepository<RoomRules> {
  private readonly rooms = new Map<string, Room<RoomRules>>();
  private readonly members = new Map<string, RoomMember[]>();

  public async createRoom(
    input: CreateRoom<RoomRules>,
  ): Promise<Room<RoomRules>> {
    const room: Room<RoomRules> = {
      id: randomUUID(),
      code: input.code,
      name: input.name,
      hostUserId: input.hostUserId,
      status: "waiting",
      capacity: input.capacity,
      version: 1,
      currentRules: input.currentRules,
      createdAt: new Date().toISOString(),
    };
    this.rooms.set(room.id, room);
    this.members.set(room.id, [
      {
        roomId: room.id,
        userId: input.hostUserId,
        ready: false,
        joinedAt: room.createdAt,
      },
    ]);
    return room;
  }

  public async findRoomById(id: string): Promise<Room<RoomRules> | undefined> {
    return this.rooms.get(id);
  }

  public async findRoomByCode(
    code: string,
  ): Promise<Room<RoomRules> | undefined> {
    return [...this.rooms.values()].find((room) => room.code === code);
  }

  public async listMembers(roomId: string): Promise<RoomMember[]> {
    return [...(this.members.get(roomId) ?? [])];
  }

  public async addMember(roomId: string, userId: string): Promise<RoomMember> {
    const room = this.requireRoom(roomId);
    this.requireWaiting(room);
    const members = this.requireMembers(roomId);
    const existing = members.find((member) => member.userId === userId);
    if (existing) return existing;
    if (members.length >= room.capacity) {
      throw new RepositoryError("ROOM_FULL", "Room capacity reached");
    }
    const member = {
      roomId,
      userId,
      ready: false,
      joinedAt: new Date().toISOString(),
    };
    members.push(member);
    room.version += 1;
    return member;
  }

  public async removeMember(roomId: string, userId: string): Promise<void> {
    const room = this.requireRoom(roomId);
    this.requireWaiting(room);
    if (room.hostUserId === userId) {
      throw new RepositoryError(
        "INVALID_STATE_TRANSITION",
        "Host must be transferred before leaving",
      );
    }
    const members = this.requireMembers(roomId);
    const index = members.findIndex((member) => member.userId === userId);
    if (index >= 0) {
      members.splice(index, 1);
      room.version += 1;
    }
  }

  public async setReady(
    roomId: string,
    userId: string,
    ready: boolean,
  ): Promise<RoomMember> {
    const room = this.requireRoom(roomId);
    this.requireWaiting(room);
    const member = this.requireMembers(roomId).find(
      (candidate) => candidate.userId === userId,
    );
    if (!member) {
      throw new RepositoryError("NOT_FOUND", "Room member not found");
    }
    if (member.ready !== ready) {
      member.ready = ready;
      room.version += 1;
    }
    return member;
  }

  public async updateRoomRules(
    roomId: string,
    hostUserId: string,
    expectedVersion: number,
    rules: VersionedRules<RoomRules>,
  ): Promise<Room<RoomRules>> {
    const room = this.requireRoom(roomId);
    this.requireWaiting(room);
    this.requireHost(room, hostUserId);
    this.requireVersion(room, expectedVersion);
    room.currentRules = rules;
    room.version += 1;
    for (const member of this.requireMembers(roomId)) member.ready = false;
    return room;
  }

  public async closeRoom(
    roomId: string,
    hostUserId: string,
  ): Promise<Room<RoomRules>> {
    const room = this.requireRoom(roomId);
    this.requireHost(room, hostUserId);
    this.requireWaiting(room);
    room.status = "closed";
    room.version += 1;
    return room;
  }

  public async transferHost(
    roomId: string,
    hostUserId: string,
    nextHostUserId: string,
  ): Promise<Room<RoomRules>> {
    const room = this.requireRoom(roomId);
    this.requireWaiting(room);
    this.requireHost(room, hostUserId);
    if (!this.requireMembers(roomId).some((member) => member.userId === nextHostUserId)) {
      throw new RepositoryError("NOT_FOUND", "New host must be a room member");
    }
    room.hostUserId = nextHostUserId;
    room.version += 1;
    return room;
  }

  private requireRoom(roomId: string): Room<RoomRules> {
    const room = this.rooms.get(roomId);
    if (!room) throw new RepositoryError("NOT_FOUND", "Room not found");
    return room;
  }

  private requireMembers(roomId: string): RoomMember[] {
    const members = this.members.get(roomId);
    if (!members) throw new RepositoryError("NOT_FOUND", "Room not found");
    return members;
  }

  private requireWaiting(room: Room<RoomRules>): void {
    if (room.status !== "waiting") {
      throw new RepositoryError(
        "INVALID_STATE_TRANSITION",
        "Room must be waiting",
      );
    }
  }

  private requireHost(room: Room<RoomRules>, userId: string): void {
    if (room.hostUserId !== userId) {
      throw new RepositoryError("FORBIDDEN", "Room host does not match");
    }
  }

  private requireVersion(room: Room<RoomRules>, expectedVersion: number): void {
    if (room.version !== expectedVersion) {
      throw new RepositoryError("CONCURRENCY_CONFLICT", "Room version is stale");
    }
  }
}
