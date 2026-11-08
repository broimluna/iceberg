import { WEBAPI_INTERNAL_URL, INTERNAL_API_SECRET } from "./config.ts";
import { isRole, type Role } from "./commands/roles.ts";

// Server-to-server reward grants. The game server decides what was earned
// and tells the WebAPI directly, rather than trusting the client to relay
// it through PUT /reward/v1, which accepts anything a modified client sends.
// RewardGrant mirrors the `reward` argument of applyRewards in
// web-api/src/routes/reward.ts.
// Client-side CustomEquipment, as used by reward.add's "equipmentInstances".
export interface EquipmentInstanceGrant {
  equipmentId: number;
  dateTimeCreated: number;
  definitionId: number;
  parts: unknown[];
}

export interface RewardGrant {
  coins?: number;
  mascotXP?: Record<string, number>;
  equipmentTemplates?: number[];
  equipmentInstances?: EquipmentInstanceGrant[];
  decals?: number[];
  fabrics?: number[];
  durables?: number[];
  tubes?: number[];
  emotePacks?: string[];
  colourPacks?: string[];
  sizzleClips?: string[];
  collectibleCurrencies?: Record<string, number>;
}

export async function fetchIdentity(swid: string): Promise<{ username: string; role: Role } | null> {
  try {
    const res = await fetch(`${WEBAPI_INTERNAL_URL}/api/internal/identity`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(INTERNAL_API_SECRET ? { "X-Internal-Secret": INTERNAL_API_SECRET } : {}) },
      body: JSON.stringify({ swid }),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { username?: unknown; role?: unknown };
    if (typeof body.username !== "string") return null;
    return { username: body.username, role: isRole(body.role) ? body.role : "player" };
  } catch (err) {
    console.log(`[${new Date().toISOString()}] webapi-client: identity lookup failed: ${(err as Error).message}`);
    return null;
  }
}

export type SetRoleResult = { ok: true; username: string } | { ok: false; reason: "unknown-user" | "config-admin" | "error" };

export async function setRole(username: string, role: Role): Promise<SetRoleResult> {
  try {
    const res = await fetch(`${WEBAPI_INTERNAL_URL}/api/internal/set-role`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(INTERNAL_API_SECRET ? { "X-Internal-Secret": INTERNAL_API_SECRET } : {}) },
      body: JSON.stringify({ username, role }),
      signal: AbortSignal.timeout(5000),
    });
    if (res.status === 404) return { ok: false, reason: "unknown-user" };
    if (res.status === 409) return { ok: false, reason: "config-admin" };
    if (!res.ok) return { ok: false, reason: "error" };
    const body = (await res.json()) as { username?: unknown };
    return { ok: true, username: typeof body.username === "string" ? body.username : username };
  } catch (err) {
    console.log(`[${new Date().toISOString()}] webapi-client: set-role failed: ${(err as Error).message}`);
    return { ok: false, reason: "error" };
  }
}

export async function grantReward(username: string, reward: RewardGrant): Promise<boolean> {
  try {
    const res = await fetch(`${WEBAPI_INTERNAL_URL}/api/internal/grant-reward`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(INTERNAL_API_SECRET ? { "X-Internal-Secret": INTERNAL_API_SECRET } : {}),
      },
      body: JSON.stringify({ username, reward }),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      console.log(`[${new Date().toISOString()}] webapi-client: grant-reward for ${username} failed with status ${res.status}`);
      return false;
    }
    console.log(`[${new Date().toISOString()}] webapi-client: granted reward to ${username}: ${JSON.stringify(reward)}`);
    return true;
  } catch (err) {
    // A down WebAPI must not take the game server with it.
    console.log(`[${new Date().toISOString()}] webapi-client: grant-reward request failed: ${(err as Error).message}`);
    return false;
  }
}

// Records a completed quest objective and returns its reward from
// quests.json. Returns null if there's nothing to grant: no active quest,
// objective already recorded, no reward, or the request failed.
export async function grantQuestObjective(username: string, objective: string): Promise<RewardGrant | null> {
  try {
    const res = await fetch(`${WEBAPI_INTERNAL_URL}/api/internal/quest-objective`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(INTERNAL_API_SECRET ? { "X-Internal-Secret": INTERNAL_API_SECRET } : {}),
      },
      body: JSON.stringify({ username, objective }),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      console.log(`[${new Date().toISOString()}] webapi-client: quest-objective for ${username}/${objective} failed with status ${res.status}`);
      return null;
    }
    const body = (await res.json()) as { reward: RewardGrant | null };
    return body.reward ?? null;
  } catch (err) {
    console.log(`[${new Date().toISOString()}] webapi-client: quest-objective request failed: ${(err as Error).message}`);
    return null;
  }
}

// Tells the WebAPI a connection closed, so the player stops showing as
// online in friend and player-card lookups. sessionId is the
// joinRoomData sessionId the WebAPI issued for this room join.
export async function reportSessionEnded(sessionId: string): Promise<void> {
  try {
    const res = await fetch(`${WEBAPI_INTERNAL_URL}/api/internal/session-ended`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(INTERNAL_API_SECRET ? { "X-Internal-Secret": INTERNAL_API_SECRET } : {}),
      },
      body: JSON.stringify({ sessionId: Number(sessionId) }),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) console.log(`[${new Date().toISOString()}] webapi-client: session-ended for ${sessionId} failed with status ${res.status}`);
  } catch (err) {
    console.log(`[${new Date().toISOString()}] webapi-client: session-ended request failed: ${(err as Error).message}`);
  }
}

// Counts a daily task event (daily-tasks.ts). The WebAPI applies it and
// returns the task's counter; changed is false when CounterMax was already
// reached, completed is true when this made the task complete.
export interface TaskIncrementResult {
  counter: number;
  changed: boolean;
  completed: boolean;
}

export async function incrementTask(username: string, taskId: string, times: number): Promise<TaskIncrementResult | null> {
  try {
    const res = await fetch(`${WEBAPI_INTERNAL_URL}/api/internal/task-increment`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(INTERNAL_API_SECRET ? { "X-Internal-Secret": INTERNAL_API_SECRET } : {}),
      },
      body: JSON.stringify({ username, taskId, times }),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      console.log(`[${new Date().toISOString()}] webapi-client: task-increment for ${username}/${taskId} failed with status ${res.status}`);
      return null;
    }
    return (await res.json()) as TaskIncrementResult;
  } catch (err) {
    console.log(`[${new Date().toISOString()}] webapi-client: task-increment request failed: ${(err as Error).message}`);
    return null;
  }
}
