export type VersionedRules<Rules> = { rulesVersion: number; rules: Rules };
export type RoomStatus = "waiting" | "active" | "closed";
export type Room<Rules> = {
  id: string; code: string; name: string; hostUserId: string;
  status: RoomStatus; capacity: number; version: number;
  currentRules: VersionedRules<Rules>; createdAt: string;
};
export type RoomMember = { roomId: string; userId: string; ready: boolean; joinedAt: string };
export type CreateRoom<Rules> = {
  code: string; name: string; hostUserId: string; capacity: number;
  currentRules: VersionedRules<Rules>;
};
export interface RoomRepository<Rules> {
  createRoom(input: CreateRoom<Rules>): Promise<Room<Rules>>;
  findRoomById(id: string): Promise<Room<Rules> | undefined>;
  findRoomByCode(code: string): Promise<Room<Rules> | undefined>;
  listMembers(roomId: string): Promise<RoomMember[]>;
  addMember(roomId: string, userId: string): Promise<RoomMember>;
  removeMember(roomId: string, userId: string): Promise<void>;
  setReady(roomId: string, userId: string, ready: boolean): Promise<RoomMember>;
  updateRoomRules(roomId: string, hostUserId: string, expectedVersion: number, rules: VersionedRules<Rules>): Promise<Room<Rules>>;
  closeRoom(roomId: string, hostUserId: string): Promise<Room<Rules>>;
  transferHost(roomId: string, hostUserId: string, nextHostUserId: string): Promise<Room<Rules>>;
}
