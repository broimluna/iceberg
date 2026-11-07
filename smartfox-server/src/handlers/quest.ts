import { SFSObjectWriter, encodePacket, type SFSObjectData } from "../sfs-wire.ts";
import { getUtfString } from "../wire-helpers.ts";
import { grantReward, grantQuestObjective, type RewardGrant } from "../webapi-client.ts";
import type { HandlerContext } from "./context.ts";

// Pushes a quest objective's reward to the client as "reward.add". The
// WebAPI returns every reward field (zeroed when unused), so empty fields
// are dropped first. Nothing is sent if nothing is left.
function sendObjectiveRewardPush(ctx: HandlerContext, reward: RewardGrant): void {
  const { session } = ctx;
  if (!session.playerSessionId) return;

  const data: Record<string, unknown> = {};
  if (reward.coins) data.coins = reward.coins;
  if (reward.mascotXP && Object.keys(reward.mascotXP).length > 0) data.mascotXP = reward.mascotXP;
  if (reward.equipmentTemplates && reward.equipmentTemplates.length > 0) data.equipmentTemplates = reward.equipmentTemplates;
  if (reward.equipmentInstances && reward.equipmentInstances.length > 0) data.equipmentInstances = reward.equipmentInstances;
  if (reward.decals && reward.decals.length > 0) data.decals = reward.decals;
  if (reward.fabrics && reward.fabrics.length > 0) data.fabrics = reward.fabrics;
  if (reward.durables && reward.durables.length > 0) data.durables = reward.durables;
  if (reward.tubes && reward.tubes.length > 0) data.tubes = reward.tubes;
  if (reward.emotePacks && reward.emotePacks.length > 0) data.emotePacks = reward.emotePacks;
  if (Object.keys(data).length === 0) return;

  const rewardPayload = {
    goodUntil: 0,
    signature: "",
    swid: "",
    data: {
      source: 0,
      sourceId: "",
      rewards: {
        [session.playerSessionId]: data,
      },
    },
  };
  const rewardParams = new SFSObjectWriter()
    .putUtfString("c", "reward.add")
    .putSFSObject("p", new SFSObjectWriter().putUtfString("reward", JSON.stringify(rewardPayload)));
  ctx.send(encodePacket(1, 13, rewardParams));
  console.log(
    `[${new Date().toISOString()}] ${ctx.peer} <- reward.add push (sessionId=${session.playerSessionId}, objective reward=${JSON.stringify(data)})`
  );
}

// "reward.broadcast" - client -> server only. `reward` = JSON
// SignedResponse<RewardedUserCollectionJsonHelper>. The client has no
// handler for a reply. Logged only until its purpose is confirmed.
export function handleRewardBroadcast(innerParams: SFSObjectData, ctx: HandlerContext): void {
  const rewardJson = getUtfString(innerParams, "reward");
  console.log(`[${new Date().toISOString()}] ${ctx.peer} - reward.broadcast received (reward=${rewardJson ?? "(none)"}), not echoing back (unconfirmed)`);
}

// "quest.set" - ack with an empty "p" object. The client ignores the
// contents, but its dispatcher reads "p" before switching on the command;
// leaving it out throws a NullReferenceException and stalls the quest
// request queue until its 35s timeout. The same applies to every
// extension response.
//
// The client sends quest.set with data = JSON
// SignedResponse<QuestStateCollection> on every room join. The active
// quest's (status 1) completedObjectives seed the list that quest.s_obj
// reports, so progress survives a room change.
const QUEST_STATUS_ACTIVE = 1;
export function handleQuestSet(innerParams: SFSObjectData, ctx: HandlerContext): void {
  const json = getUtfString(innerParams, "data");
  if (json) {
    try {
      const quests = JSON.parse(json)?.data;
      if (Array.isArray(quests)) {
        const active = quests.find((q) => q?.status === QUEST_STATUS_ACTIVE || q?.status === "ACTIVE");
        const objectives: unknown[] = Array.isArray(active?.completedObjectives) ? active.completedObjectives : [];
        ctx.session.completedObjectives.splice(0, Infinity, ...objectives.filter((o): o is string => typeof o === "string"));
      }
    } catch (err) {
      console.log(`[${new Date().toISOString()}] ${ctx.peer} - quest.set: failed to parse "data" JSON: ${(err as Error).message}`);
    }
  }
  ctx.send(encodePacket(1, 13, new SFSObjectWriter().putUtfString("c", "quest.set").putSFSObject("p", new SFSObjectWriter())));
  console.log(`[${new Date().toISOString()}] ${ctx.peer} <- extension ack (c=quest.set)`);
  sendStarterRewards(ctx);
}

// "quest.c_obj" - the client's quest request queue waits (35s timeout) for
// "quest.s_obj", whose data is the full list of objectives completed so far
// in the active quest, not only the newest one.
export function handleQuestCompleteObjective(innerParams: SFSObjectData, ctx: HandlerContext): void {
  const objectiveName = getUtfString(innerParams, "obj");
  if (objectiveName && !ctx.session.completedObjectives.includes(objectiveName)) {
    ctx.session.completedObjectives.push(objectiveName);
  }
  const payload = {
    goodUntil: 0,
    signature: "",
    swid: "",
    data: ctx.session.completedObjectives,
  };
  // Same nested-"p" requirement as reward.add.
  const responseParams2 = new SFSObjectWriter()
    .putUtfString("c", "quest.s_obj")
    .putSFSObject("p", new SFSObjectWriter().putUtfString("data", JSON.stringify(payload)));
  ctx.send(encodePacket(1, 13, responseParams2));
  console.log(
    `[${new Date().toISOString()}] ${ctx.peer} <- quest.s_obj push (objective=${objectiveName}, all=${JSON.stringify(ctx.session.completedObjectives)})`
  );

  // quest.s_obj grants nothing by itself. Look up the objective's reward
  // (quests.json) and push it as reward.add. Fire-and-forget.
  if (objectiveName) {
    void grantQuestObjective(ctx.session.userName, objectiveName).then((reward) => {
      if (reward) sendObjectiveRewardPush(ctx, reward);
    });
  }
}

// Starter pack, sent as "reward.add" (c=1, a=13; "reward" is a JSON string,
// not an SFSObject). Without it the player owns no durables, and quests that
// need one, like the Rockhopper jackhammer, softlock.
//   - "rewards" is keyed by the client's own joinRoomData sessionId (as a
//     string), not the SFS user id.
//   - [15, 86] is ProgressionUnlock_Pack_0's durables (15 = GearJackhammer;
//     86 is unidentified).
//   - Sent on the first quest.set rather than at login: at login the
//     client's RewardService isn't listening yet and the push is lost.
export function sendStarterRewards(ctx: HandlerContext): void {
  const { session } = ctx;
  if (session.starterRewardsSent || !session.playerSessionId) return;
  session.starterRewardsSent = true;
  const rewardPayload = {
    goodUntil: 0,
    signature: "",
    swid: "",
    data: {
      source: 0,
      sourceId: "",
      rewards: {
        [session.playerSessionId]: {
          durables: [15, 86],
        },
      },
    },
  };
  const rewardParams = new SFSObjectWriter()
    .putUtfString("c", "reward.add")
    .putSFSObject("p", new SFSObjectWriter().putUtfString("reward", JSON.stringify(rewardPayload)));
  ctx.send(encodePacket(1, 13, rewardParams));
  console.log(`[${new Date().toISOString()}] ${ctx.peer} <- reward.add push (sessionId=${session.playerSessionId}, durables=[15,86])`);

  // Persist the grant server-side too (see webapi-client.ts). Fire-and-forget.
  void grantReward(session.userName, { durables: [15, 86] });
}
