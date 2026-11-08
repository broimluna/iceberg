import type { HandlerContext } from "../handlers/context.ts";
import { getByAccountName, type RegisteredSession } from "../session-registry.ts";
import { hasRole, type Role } from "./roles.ts";
import { reply, replyError } from "./reply.ts";
import { commands as info } from "./info.ts";
import { commands as moderation } from "./moderation.ts";

// Staff chat commands: chat starting with ":" and two or more letters, from a
// moderator or admin. Anything else, including every player's chat and
// emoticons like ":)" or ":D", is ordinary chat.
export interface CommandDef {
  name: string;
  minRole: Role;
  usage: string;
  run(args: string[], ctx: HandlerContext): void | Promise<void>;
}

export const commandTable: CommandDef[] = [...info, ...moderation];

/** Runs a staff command; false means the text is ordinary chat. */
export function handleCommand(text: string, ctx: HandlerContext): boolean {
  const { session } = ctx;
  if (!hasRole(session, "moderator")) return false;
  const trimmed = text.trim();
  // At least two letters, so emoticons like :D and :P stay chat.
  if (!/^:[A-Za-z]{2,}(\s|$)/.test(trimmed)) return false;
  const [word, ...args] = trimmed.slice(1).split(/\s+/);
  const name = word!.toLowerCase();
  const def = commandTable.find((c) => c.name === name);
  if (!def || !hasRole(session, def.minRole)) {
    replyError(ctx, "Unknown command");
    return true;
  }
  console.log(`[${new Date().toISOString()}] ${ctx.peer} staff ${session.accountName} ran :${name} ${args.join(" ")}`.trimEnd());
  const fail = (err: unknown) => {
    console.log(`[${new Date().toISOString()}] ${ctx.peer} - :${name} failed: ${(err as Error)?.stack ?? err}`);
    replyError(ctx, "Command failed");
  };
  try {
    const result = def.run(args, ctx);
    if (result) result.catch(fail);
  } catch (err) {
    fail(err);
  }
  return true;
}

export function usage(ctx: HandlerContext, def: Pick<CommandDef, "usage">): void {
  replyError(ctx, `Usage: ${def.usage}`);
}

/**
 * The named online player, or the caller when name is omitted. Replies
 * "<name> isn't online" on a miss unless quiet.
 */
export function resolveTarget(ctx: HandlerContext, name: string | undefined, opts: { quiet?: boolean } = {}): RegisteredSession | undefined {
  if (name === undefined) return { session: ctx.session, peer: ctx.peer, send: ctx.send, close: () => {} };
  const target = getByAccountName(name);
  if (!target && !opts.quiet) replyError(ctx, `${name} isn't online`);
  return target;
}

export { reply, replyError };
