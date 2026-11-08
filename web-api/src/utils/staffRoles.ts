// Staff roles for the game server's chat commands. The stored role lives
// in players.role; accounts listed in STAFF_ADMINS (comma-separated
// usernames, any case) are always admin, whatever the column says.
export const STAFF_ROLES = ["player", "moderator", "admin"] as const;
export type StaffRole = (typeof STAFF_ROLES)[number];

export function isStaffRole(value: unknown): value is StaffRole {
    return typeof value === "string" && (STAFF_ROLES as readonly string[]).includes(value);
}

export function isStaffAdmin(username: string): boolean {
    const admins = (process.env.STAFF_ADMINS ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
    return admins.includes(username.toLowerCase());
}

export function effectiveRole(username: string, stored: string | null): StaffRole {
    if (isStaffAdmin(username)) return "admin";
    return isStaffRole(stored) ? stored : "player";
}
