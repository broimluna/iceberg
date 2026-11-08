import type { HandlerContext } from "../handlers/context.ts";
import { getByAccountName, type RegisteredSession } from "../session-registry.ts";
import type { Role } from "./roles.ts";
import { replyError } from "./reply.ts";

export interface CommandDef {
  name: string;
  minRole: Role;
  usage: string;
  run(args: string[], ctx: HandlerContext): void | Promise<void>;
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

export { reply, replyError } from "./reply.ts";
