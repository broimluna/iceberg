import { SFSObjectWriter, encodePacket } from "../sfs-wire.ts";
import { canLift, findMute, mute, unmute } from "../mutes.ts";
import type { HandlerContext } from "../handlers/context.ts";
import type { RegisteredSession } from "../session-registry.ts";
import { ROLE_LEVEL } from "./roles.ts";
import { reply, replyError, resolveTarget, usage, type CommandDef } from "./common.ts";
import { systemChatPacket } from "./reply.ts";

// System action 1005, ClientDisconnection: both client APIs read "dr" as a
// byte index into (idle, kick, ban, ...) and disconnect with that reason.
export const DISCONNECT_IDLE = 0;
export const DISCONNECT_KICK = 1;
export function disconnectPacket(reason: number) {
  return encodePacket(0, 1005, new SFSObjectWriter().putByte("dr", reason));
}

/** The target, unless it's the caller or holds an equal or higher role (replies itself). */
function targetBelowCaller(ctx: HandlerContext, name: string, verb: string): RegisteredSession | undefined {
  const target = resolveTarget(ctx, name);
  if (!target) return undefined;
  if (target.session.userId === ctx.session.userId) {
    replyError(ctx, `You can't ${verb} yourself`);
    return undefined;
  }
  if (ROLE_LEVEL[target.session.role] >= ROLE_LEVEL[ctx.session.role]) {
    replyError(ctx, `You can't ${verb} ${target.session.accountName}`);
    return undefined;
  }
  return target;
}

const DEFAULT_MUTE_MINUTES = 10;
const MAX_MUTE_MINUTES = 1440;

export const commands: CommandDef[] = [
  {
    name: "kick",
    minRole: "moderator",
    usage: ":kick <user>",
    run(args, ctx) {
      if (args.length !== 1) return usage(ctx, this);
      const target = targetBelowCaller(ctx, args[0]!, "kick");
      if (!target) return;
      target.send(disconnectPacket(DISCONNECT_KICK));
      // Give the client a moment to read the reason before the socket goes.
      setTimeout(() => target.close(), 100);
      reply(ctx, `Kicked ${target.session.accountName}`);
    },
  },
  {
    name: "mute",
    minRole: "moderator",
    usage: `:mute <user> [minutes 1-${MAX_MUTE_MINUTES}, default ${DEFAULT_MUTE_MINUTES}]`,
    run(args, ctx) {
      if (args.length < 1 || args.length > 2) return usage(ctx, this);
      const minutes = args[1] === undefined ? DEFAULT_MUTE_MINUTES : /^\d+$/.test(args[1]) ? Number(args[1]) : NaN;
      if (!(minutes >= 1 && minutes <= MAX_MUTE_MINUTES)) return usage(ctx, this);
      const target = targetBelowCaller(ctx, args[0]!, "mute");
      if (!target) return;
      if (!target.session.swid) return replyError(ctx, `Can't mute ${target.session.accountName}`);
      mute({ swid: target.session.swid, accountName: target.session.accountName! }, minutes, ctx.session.role);
      target.send(systemChatPacket(target.session, `You are muted for ${minutes} minute${minutes === 1 ? "" : "s"}`, true));
      reply(ctx, `Muted ${target.session.accountName} for ${minutes} minute${minutes === 1 ? "" : "s"}`);
    },
  },
  {
    name: "unmute",
    minRole: "moderator",
    usage: ":unmute <user>",
    run(args, ctx) {
      if (args.length !== 1) return usage(ctx, this);
      // Works for players who are offline too.
      const online = resolveTarget(ctx, args[0], { quiet: true });
      const found = online?.session.swid ? findMute(online.session.accountName!) : findMute(args[0]!);
      const name = found?.mute.accountName ?? online?.session.accountName ?? args[0]!;
      if (!found) return replyError(ctx, `${name} isn't muted`);
      if (found.swid === ctx.session.swid) return replyError(ctx, "You can't unmute yourself");
      if (!canLift(found.mute, ctx.session.role)) return replyError(ctx, `${name} was muted by ${found.mute.setBy === "admin" ? "an" : "a"} ${found.mute.setBy}`);
      unmute(found.swid);
      reply(ctx, `Unmuted ${name}`);
    },
  },
];
