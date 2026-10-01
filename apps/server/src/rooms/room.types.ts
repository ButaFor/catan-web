import type {
  Room,
  RoomMember,
  RoomRepository,
  VersionedRules,
} from "../db/contracts/room.js";

export type RoomRules = Record<string, never>;
export type RoomRepositoryPort = RoomRepository<RoomRules>;
export type RoomModel = Room<RoomRules>;
export type RoomMemberModel = RoomMember;
export type RoomRulesInput = VersionedRules<RoomRules>;

export type RoomDetails = {
  room: RoomModel;
  members: RoomMemberModel[];
};
