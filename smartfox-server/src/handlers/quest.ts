import { SFSObjectWriter, encodePacket, type SFSObjectData } from "../sfs-wire.ts";
import { getUtfString, fitsBytes } from "../wire-helpers.ts";
import { grantReward, grantQuestObjective, type RewardGrant } from "../webapi-client.ts";
import type { HandlerContext } from "./context.ts";
import { withAccount } from "../account.ts";
import { sendRewardPush } from "../reward-push.ts";
import { logSafe } from "../log-safe.ts";

// "reward.broadcast" - client -> server only. `reward` = JSON
// SignedResponse<RewardedUserCollectionJsonHelper>. The client has no
// handler for a reply. Logged only until its purpose is confirmed.
export function handleRewardBroadcast(innerParams: SFSObjectData, ctx: HandlerContext): void {
  const rewardJson = getUtfString(innerParams, "reward");
  console.log(`[${new Date().toISOString()}] ${ctx.peer} - reward.broadcast received (reward=${logSafe(rewardJson ?? "(none)")}), not echoing back (unconfirmed)`);
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
// Real quests have at most 11 objectives, with names under 20 characters.
const MAX_OBJECTIVES = 64;
const MAX_OBJECTIVE_BYTES = 64;
const isObjectiveName = (o: unknown): o is string => typeof o === "string" && o.length > 0 && fitsBytes(o, MAX_OBJECTIVE_BYTES);
export function handleQuestSet(innerParams: SFSObjectData, ctx: HandlerContext): void {
  const json = getUtfString(innerParams, "data");
  if (json) {
    try {
      const quests = JSON.parse(json)?.data;
      if (Array.isArray(quests)) {
        const active = quests.find((q) => q?.status === QUEST_STATUS_ACTIVE || q?.status === "ACTIVE");
        const objectives: unknown[] = Array.isArray(active?.completedObjectives) ? active.completedObjectives : [];
        const kept = [...new Set(objectives.filter(isObjectiveName))].slice(0, MAX_OBJECTIVES);
        ctx.session.completedObjectives.splice(0, Infinity, ...kept);
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
  const sent = getUtfString(innerParams, "obj");
  const objectiveName = isObjectiveName(sent) ? sent : undefined;
  const list = ctx.session.completedObjectives;
  if (objectiveName && !list.includes(objectiveName) && list.length < MAX_OBJECTIVES) list.push(objectiveName);
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
    `[${new Date().toISOString()}] ${ctx.peer} <- quest.s_obj push (objective=${logSafe(objectiveName)}, ${ctx.session.completedObjectives.length} completed)`
  );

  // quest.s_obj grants nothing by itself. Look up the objective's reward
  // (quests.json) and push it as reward.add. Fire-and-forget.
  if (objectiveName) {
    withAccount(ctx.session, `objective ${objectiveName}`, (account) =>
      grantQuestObjective(account, objectiveName).then((reward) => {
        if (reward) sendRewardPush(ctx, reward, "objective reward");
      })
    );
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
  withAccount(session, "starter pack", (account) => grantReward(account, { durables: [15, 86] }));
}
