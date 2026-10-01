import type { Session, User } from "../db/contracts/auth.js";

export type {
  OAuthAccount,
  Session,
  User,
} from "../db/contracts/auth.js";

export type AuthenticatedUser = {
  user: User;
  session: Session;
};
