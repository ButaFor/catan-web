import { z } from "zod";

export const createGuestSchema = z.object({}).strict();

export const registerSchema = z.object({
  username: z.string().trim().min(3).max(30).regex(/^[a-zA-Z0-9_]+$/),
  password: z.string().min(8).max(128),
});

export const loginSchema = registerSchema;

export const userResponseSchema = z.object({
  id: z.string().uuid(),
  displayName: z.string().min(1),
  isGuest: z.boolean(),
  createdAt: z.iso.datetime(),
  email: z.email().optional(),
  avatarUrl: z.url().optional(),
  username: z.string().min(3).optional(),
});

export type UserResponse = z.infer<typeof userResponseSchema>;

export const googleCallbackSchema = z.object({
  code: z.string().min(1).optional(),
  state: z.string().min(1),
  error: z.string().optional(),
});
