import { z } from "zod";

export const roomJoinPayload = z.object({
  roomId: z.string().uuid(),
});

export const roomLeavePayload = z.object({
  roomId: z.string().uuid(),
});

export const roomReadyPayload = z.object({
  roomId: z.string().uuid(),
  ready: z.boolean(),
});

export type RoomJoinPayload = z.infer<typeof roomJoinPayload>;
export type RoomLeavePayload = z.infer<typeof roomLeavePayload>;
export type RoomReadyPayload = z.infer<typeof roomReadyPayload>;

export const realtimeError = z.object({
  code: z.string(),
  message: z.string(),
});

export type RealtimeError = z.infer<typeof realtimeError>;

export const roomUpdatedEvent = "room:updated";
