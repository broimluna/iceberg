import { WEBAPI_INTERNAL_URL, INTERNAL_API_SECRET } from "./config.ts";

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
