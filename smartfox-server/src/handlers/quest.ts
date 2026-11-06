import { SFSObjectWriter, encodePacket, type SFSObjectData } from "../sfs-wire.ts";
import { getUtfString } from "../wire-helpers.ts";
import { grantReward, grantQuestObjective, type RewardGrant } from "../webapi-client.ts";
import type { HandlerContext } from "./context.ts";

// Builds and sends the same "reward.add" push sendStarterRewards below
// uses, but for a reward resolved dynamically (an objective's real
// quests.json-configured grant) instead of the hardcoded starter pack -
// see webapi-client.ts's grantQuestObjective for how that's resolved.
// grantRewards() (web-api's routes/quest.ts) always returns every field
// initialized (coins:0, mascotXP:{}, durables:[], ...) regardless of
// what was actually granted, so this filters down to only the
// populated ones before serializing - an empty "reward.add" push is
// worse than none (see reward.broadcast's own comment on this project's
// general wariness of unconfirmed wire traffic).
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

// SmartfoxCommand.SEND_EARNED_REWARDS ("reward.broadcast",
// SMARTFOX_PACKETS_DOCUMENTATION.md's Rewards section) - documented OUT
// only: `reward` = JSON `SignedResponse<RewardedUserCollectionJsonHelper>`,
// "client broadcasting its own earned rewards (to the room? to other
// systems?) rather than receiving them" per the doc's own uncertainty -
// there's no confirmed IN case in the decompiled dispatch switch for this
// command. The old recovered Java extension echoes it straight back as
// reward.add (RECEIVED_REWARDS) on the theory the client needs that to
// then call the WebAPI's PUT /reward/v1 - plausible (it's exactly what a
// historically-working setup did), but not decompiled-source-confirmed
// the way sendStarterRewards' reward.add push below is. Not echoing
// anything back until that's actually verified against a real capture;
// logging only for now.
export function handleRewardBroadcast(innerParams: SFSObjectData, ctx: HandlerContext): void {
  const rewardJson = getUtfString(innerParams, "reward");
  console.log(`[${new Date().toISOString()}] ${ctx.peer} - reward.broadcast received (reward=${rewardJson ?? "(none)"}), not echoing back (unconfirmed)`);
}

// SMARTFOX_PACKETS_DOCUMENTATION.md's "no payload consumed" note is true
// for the *deserialized* content (SmartfoxCommand.SET_QUEST_STATES
// ignores it, data=null unconditionally, ClubPenguinClient.decompiled.cs:
// 2103-2106) - but it does NOT mean the wire packet can omit "p" entirely.
// Confirmed via a live crash: onExtensionResponse
// (ClubPenguinClient.decompiled.cs:2037) does
// `iSFSObject.ContainsKey("senderId")` on evt.Params["params"] BEFORE the
// switch even runs - populated from content.GetSFSObject("p")
// (SmartFox2X.decompiled.cs:2430), which returns a bare null when "p" is
// absent. A prior ack sent only {c:"quest.set"}, no "p" - producing a
// NullReferenceException caught by SFS2X's own ExtensionController
// dispatch, leaving QuestService's request queue stuck until its own 35s
// timeout, every single quest update, all session. Fixed by sending an
// (empty is fine, content is never read) nested "p" SFSObject, same
// requirement already found for reward.add/quest.s_obj.
export function handleQuestSet(ctx: HandlerContext): void {
  ctx.send(encodePacket(1, 13, new SFSObjectWriter().putUtfString("c", "quest.set").putSFSObject("p", new SFSObjectWriter())));
  console.log(`[${new Date().toISOString()}] ${ctx.peer} <- extension ack (c=quest.set)`);
  sendStarterRewards(ctx);
}

// RequestType.CallExtension, cmd="quest.c_obj" (SmartfoxCommand.
// COMPLETE_OBJECTIVE, ClubPenguinClient.decompiled.cs:7671) - sent from
// QuestService.processRequest (Network.decompiled.cs:3875) as part of a
// request queue with a 35s timeout before the next queued quest update is
// processed. The client is waiting for SmartfoxCommand.
// SERVER_OBJECTIVE_COMPLETED ("quest.s_obj") - confirmed shape from
// OfflineGameServerClient's own local simulation of this exact round-trip
// (questCompleteObjectiveResponse, ClubPenguinClient.decompiled.cs:12558):
// QuestObjectives (ClubPenguinClient.decompiled.cs:10921, a plain
// List<string>) is the *running set* of every objective completed so far
// for the active quest, not just the newest one - so accumulate rather
// than replace.
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

  // quest.s_obj above only acks the objective to the client's own FSM -
  // it grants nothing. Whatever this specific objective is configured to
  // reward in quests.json (e.g. an equipment instance) still needs to
  // actually land in the player's inventory, the same "reward.add push
  // is the one path that's both server-initiated and actually writes to
  // local inventory" mechanism sendStarterRewards below relies on for the
  // starter pack - generalized here per-objective instead of hardcoded.
  // Fire-and-forget: the WebAPI round trip shouldn't hold up the ack
  // above, and webapi-client.ts already logs/swallows its own failures.
  if (objectiveName) {
    void grantQuestObjective(ctx.session.userName, objectiveName).then((reward) => {
      if (reward) sendObjectiveRewardPush(ctx, reward);
    });
  }
}

// Starter-asset grant push (SmartfoxCommand.RECEIVED_REWARDS =
// "reward.add", ClubPenguinClient.decompiled.cs:7690). This is the one
// reward path that's both server-initiated *and* actually writes to local
// inventory in OfflineMode - AddRewardOperation.PerformOfflineAction
// (ClubPenguinClient.decompiled.cs:6928) is fully implemented, and
// persists straight into OfflineDatabase's PlayerAssets.Assets.durables
// via SetOfflineData. Without this push, Assets.durables stays empty
// forever and nothing ever equips for real, even though quest-FSM
// auto-equip UI/button state updates regardless (this was the cause of
// the Rockhopper jackhammer quest softlock). Envelope shape confirmed at
// ClubPenguinClient.decompiled.cs:2138 (c=1, a=13, same as quest.set -
// params has "c" plus a sibling "reward" key holding a JSON *string*, not
// a nested SFSObject). "rewards" is keyed by player session id as a
// string (long.Parse'd on receipt, RewardedUserCollectionJsonHelper line
// 11439) - NOT our SFS2X login "id", a completely different id space
// (PlayerSessionId is JoinRoomDataSessionId, the CLIENT's own fabricated
// joinRoomData.data.sessionId). [15, 86] is ProgressionUnlock_Pack_0's
// real durables grant from the CDN catalog data (15 = GearJackhammer,
// PropType Durable, Cost 0 - the one this whole investigation started
// from; 86 not yet identified). Called once the client's own first
// quest.set push arrives - proof QuestService (and by extension the rest
// of the zone's services) is actually up, since firing this synchronously
// at login time loses the event to a RewardService that hasn't finished
// registering its listeners yet.
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

  // This server's own game logic just decided this reward is earned, so
  // it grants it directly to the WebAPI (server-to-server) instead of
  // relying solely on the client to relay the reward.add push above into
  // WebAPI's `PUT /reward/v1` - that client-relay path alone is a real,
  // unvalidated gap (see webapi-client.ts). Fire-and-forget:
  // webapi-client.ts already logs/swallows its own failures, and nothing
  // in the wire protocol above needs to wait on this HTTP call.
  void grantReward(session.userName, { durables: [15, 86] });
}
