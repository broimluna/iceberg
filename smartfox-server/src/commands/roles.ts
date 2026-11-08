import type { Session } from "../session.ts";

// Staff roles, from the web API (POST /api/internal/identity). Only a
// signed login can hold one above "player".
export type Role = "player" | "moderator" | "admin";
export const ROLE_LEVEL: Record<Role, number> = { player: 0, moderator: 1, admin: 2 };

export function isRole(value: unknown): value is Role {
  return value === "player" || value === "moderator" || value === "admin";
}

export function hasRole(session: Session, min: Role): boolean {
  return ROLE_LEVEL[session.role] >= ROLE_LEVEL[min];
}
