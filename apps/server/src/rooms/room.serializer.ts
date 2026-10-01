import type { RoomDetails } from "./room.types.js";

export function toRoomResponse(details: RoomDetails) {
  return {
    id: details.room.id,
    code: details.room.code,
    name: details.room.name,
    hostUserId: details.room.hostUserId,
    status: details.room.status,
    capacity: details.room.capacity,
    version: details.room.version,
    currentRules: details.room.currentRules,
    createdAt: details.room.createdAt,
    members: details.members,
  };
}
