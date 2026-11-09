import { grantReward, type RewardGrant } from "../webapi-client.ts";
import { sendRewardPush } from "../reward-push.ts";
import type { HandlerContext } from "../handlers/context.ts";
import type { RegisteredSession } from "../session-registry.ts";
import { reply, replyError, resolveTarget, usage, type CommandDef } from "./common.ts";

const MAX_COINS = 1_000_000;

// :ai types and the reward field each fills. Colour and emote packs are
// string ids on the client; the rest are numbers.
const ITEM_TYPES = {
  // An instance, so the item shows up in My Stuff (a bare template doesn't).
  equipment: { field: "equipmentInstances", numeric: true },
  durable: { field: "durables", numeric: true },
  tube: { field: "tubes", numeric: true },
  decal: { field: "decals", numeric: true },
  fabric: { field: "fabrics", numeric: true },
  emote: { field: "emotePacks", numeric: false },
  colour: { field: "colourPacks", numeric: false },
} as const;
type ItemType = keyof typeof ITEM_TYPES;

/** Saves the grant in the web API, then shows it in the player's game; only a saved grant is pushed. */
async function give(ctx: HandlerContext, target: RegisteredSession, grant: RewardGrant, description: string): Promise<void> {
  const account = target.session.accountName;
  const granted = account ? await grantReward(account, grant) : null;
  if (!granted) {
    replyError(ctx, "Couldn't save the reward");
    return;
  }
  sendRewardPush(target, granted, "staff grant");
  reply(ctx, `Gave ${description} to ${account}`);
}

export const commands: CommandDef[] = [
  {
    name: "ac",
    minRole: "admin",
    usage: `:ac <coins 1-${MAX_COINS}> [user]`,
    async run(args, ctx) {
      if (args.length < 1 || args.length > 2 || !/^\d+$/.test(args[0]!)) return usage(ctx, this);
      const amount = Number(args[0]);
      if (amount < 1 || amount > MAX_COINS) return usage(ctx, this);
      const target = resolveTarget(ctx, args[1]);
      if (target) await give(ctx, target, { coins: amount }, `${amount} coins`);
    },
  },
  {
    name: "ai",
    minRole: "admin",
    usage: `:ai <${Object.keys(ITEM_TYPES).join("|")}> <id> [user]`,
    async run(args, ctx) {
      if (args.length < 2 || args.length > 3) return usage(ctx, this);
      const type = args[0]!.toLowerCase();
      if (!Object.hasOwn(ITEM_TYPES, type)) return usage(ctx, this);
      const { field, numeric } = ITEM_TYPES[type as ItemType];
      const id = args[1]!;
      if (!(numeric ? /^\d+$/ : /^[A-Za-z0-9_.-]+$/).test(id)) return usage(ctx, this);
      const target = resolveTarget(ctx, args[2]);
      if (!target) return;
      const value = field === "equipmentInstances" ? { definitionId: Number(id), parts: [] } : numeric ? Number(id) : id;
      const grant = { [field]: [value] } as RewardGrant;
      await give(ctx, target, grant, `${type} ${id}`);
    },
  },
];
