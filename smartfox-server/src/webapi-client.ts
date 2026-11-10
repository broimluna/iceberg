import { WEBAPI_INTERNAL_URL } from "./config.ts";
import { internalHeaders } from "./internal-secret.ts";
import { isRole, type Role } from "./commands/roles.ts";

// Server-to-server reward grants. The game server decides what was earned
// and tells the WebAPI directly, rather than trusting the client to relay
// it through PUT /reward/v1, which accepts anything a modified client sends.
// RewardGrant mirrors the `reward` argument of applyRewards in
// web-api/src/routes/reward.ts.
// Client-side CustomEquipment, as used by reward.add's "equipmentInstances".
export interface EquipmentInstanceGrant {
  equipmentId?: number; // assigned by the WebAPI
  dateTimeCreated?: number;
  definitionId: number;
  parts?: unknown[];
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
      headers: internalHeaders(),
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
      headers: internalHeaders(),
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

export async function grantReward(username: string, reward: RewardGrant): Promise<RewardGrant | null> {
  try {
    const res = await fetch(`${WEBAPI_INTERNAL_URL}/api/internal/grant-reward`, {
      method: "POST",
      headers: internalHeaders(),
      body: JSON.stringify({ username, reward }),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      console.log(`[${new Date().toISOString()}] webapi-client: grant-reward for ${username} failed with status ${res.status}`);
      return null;
    }
    // The WebAPI echoes the reward with database ids filled in (equipment instances).
    const body = (await res.json().catch(() => null)) as { reward?: RewardGrant } | null;
    const granted = body?.reward ?? reward;
    console.log(`[${new Date().toISOString()}] webapi-client: granted reward to ${username}: ${JSON.stringify(granted)}`);
    return granted;
  } catch (err) {
    // A down WebAPI must not take the game server with it.
    console.log(`[${new Date().toISOString()}] webapi-client: grant-reward request failed: ${(err as Error).message}`);
    return null;
  }
}

// Records a completed quest objective and returns its reward from
// quests.json. Returns null if there's nothing to grant: no active quest,
// objective already recorded, no reward, or the request failed.
export async function grantQuestObjective(username: string, objective: string): Promise<RewardGrant | null> {
  try {
    const res = await fetch(`${WEBAPI_INTERNAL_URL}/api/internal/quest-objective`, {
      method: "POST",
      headers: internalHeaders(),
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
      headers: internalHeaders(),
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
      headers: internalHeaders(),
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

// Party state kept by the web API (calendar plus admin override).
export interface PartyState {
  mode: "auto" | "party" | "none";
  party: string | null;
  active: string[];
}

function asPartyState(v: unknown): PartyState | null {
  const b = v as Partial<PartyState> | null;
  if (!b || typeof b !== "object") return null;
  if (b.mode !== "auto" && b.mode !== "party" && b.mode !== "none") return null;
  if (b.party !== null && typeof b.party !== "string") return null;
  if (!Array.isArray(b.active) || !b.active.every((k) => typeof k === "string")) return null;
  return { mode: b.mode, party: b.party, active: b.active };
}

export async function fetchParty(): Promise<PartyState | null> {
  try {
    const res = await fetch(`${WEBAPI_INTERNAL_URL}/api/internal/party`, { headers: internalHeaders(), signal: AbortSignal.timeout(5000) });
    if (!res.ok) return null;
    return asPartyState(await res.json());
  } catch {
    return null;
  }
}

export type PartyOverrideResult =
  | { ok: true; state: PartyState }
  | { ok: false; reason: "unknown-party" | "bad-mode" | "error"; valid?: string[] };

export async function setPartyOverride(body: { mode: string; party?: string; setBy: string }): Promise<PartyOverrideResult> {
  try {
    const res = await fetch(`${WEBAPI_INTERNAL_URL}/api/internal/party-override`, {
      method: "POST",
      headers: internalHeaders(),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    });
    const json = (await res.json().catch(() => null)) as { error?: string; valid?: unknown } | null;
    if (res.ok) {
      const state = asPartyState(json);
      return state ? { ok: true, state } : { ok: false, reason: "error" };
    }
    if (res.status === 400 && json?.error === "unknown party") {
      return { ok: false, reason: "unknown-party", valid: Array.isArray(json.valid) ? json.valid.filter((v): v is string => typeof v === "string") : undefined };
    }
    if (res.status === 400 && json?.error === "bad mode") return { ok: false, reason: "bad-mode" };
    return { ok: false, reason: "error" };
  } catch {
    return { ok: false, reason: "error" };
  }
}
