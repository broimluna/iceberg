import { SFSObjectWriter, encodePacket, type OutgoingPacket } from "./sfs-wire.ts";
import type { RewardGrant } from "./webapi-client.ts";
import type { Session } from "./session.ts";

// Pushes a granted reward to the player's client as "reward.add", keyed by
// their joinRoomData sessionId. The WebAPI returns every reward field
// (zeroed when unused), so empty fields are dropped first. Nothing is sent
// if nothing is left.
export function sendRewardPush(
  target: { session: Session; send: (packet: OutgoingPacket) => void; peer?: string },
  reward: RewardGrant,
  what: string
): void {
  const { session } = target;
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
  if (reward.colourPacks && reward.colourPacks.length > 0) data.colourPacks = reward.colourPacks;
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
  target.send(encodePacket(1, 13, rewardParams));
  console.log(
    `[${new Date().toISOString()}] ${target.peer ?? session.userId} <- reward.add push (sessionId=${session.playerSessionId}, ${what}=${JSON.stringify(data)})`
  );
}
