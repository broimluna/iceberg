import { WEBAPI_INTERNAL_URL, INTERNAL_API_SECRET } from "./config.ts";

// Server-to-server reward granting - POSTs straight to the WebAPI's own
// internal endpoints (like /api/internal/add-coins), bypassing the client
// entirely, instead of the vulnerable pattern found auditing the WebAPI:
// `PUT /reward/v1` (web-api/src/routes/reward.ts) trusts whatever
// reward blob the client PUTs, with zero validation - a modified client
// can grant itself anything with no SFS2X round-trip at all. Calling this
// directly from wherever this server's own game logic decides a reward is
// earned (quest completion today; target hits/party games later) means
// the client's cooperation is never required for the grant to be real.
//
// Shape matches routes/reward.js's own `applyRewards(username, reward)` -
// same `reward` fields (coins/mascotXP/equipmentTemplates/decals/fabrics/
// durables/tubes/emotePacks/colourPacks/sizzleClips/collectibleCurrencies),
// not reinvented here.
// [dateTimeCreated, definitionId, parts, equipmentId] - CustomEquipment's
// real wire shape (ClubPenguin.Net.Domain/CustomEquipment.cs), the same
// field set quests.json's own equipmentInstances reward entries already
// use - confirmed this is what a reward.add push's "equipmentInstances"
// key deserializes into client-side (AbstractListReward<CustomEquipment>.
// FromJson -> LitJson JsonMapper.ToObject<List<CustomEquipment>>).
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
    // WebAPI being offline shouldn't crash the game server - same
    // tolerance smartfoxNotifier.js already has for its own direction
    // (ECONNREFUSED is expected during development, not fatal).
    console.log(`[${new Date().toISOString()}] webapi-client: grant-reward request failed: ${(err as Error).message}`);
    return false;
  }
}

// Resolves+persists whatever reward quests.json attaches to this
// objective, keyed off the player's active quest server-side (quest.c_obj
// only ever carries the bare objective name - see handlers/quest.ts's
// handleQuestCompleteObjective). Returns null on no active quest, an
// already-recorded objective, an objective with no reward, or any
// request failure - all "nothing to push back to the client" cases,
// deliberately not distinguished further here.
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
