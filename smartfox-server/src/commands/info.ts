import { getAll } from "../session-registry.ts";
import { hasRole } from "./roles.ts";
import { reply, resolveTarget, usage, type CommandDef } from "./common.ts";
import { commandTable } from "./index.ts";

const MAX_BUBBLE = 200;

/** Splits text into bubbles of at most MAX_BUBBLE characters, breaking after ", ". */
function bubbles(parts: string[], first: string): string[] {
  const out: string[] = [];
  let line = first;
  for (const part of parts) {
    const piece = (line === first ? "" : ", ") + part;
    if (line.length + piece.length > MAX_BUBBLE && line !== first) {
      out.push(line);
      line = part;
    } else {
      line += piece;
    }
  }
  out.push(line);
  return out;
}

export const commands: CommandDef[] = [
  {
    name: "help",
    minRole: "moderator",
    usage: ":help",
    run(_args, ctx) {
      const lines = commandTable().filter((c) => hasRole(ctx.session, c.minRole)).map((c) => c.usage);
      for (const b of bubbles(lines, "Commands: ")) reply(ctx, b);
    },
  },
  {
    name: "online",
    minRole: "moderator",
    usage: ":online",
    run(_args, ctx) {
      const names = getAll().map((e) => e.session.accountName ?? `(unverified ${e.session.userName})`);
      for (const b of bubbles(names, `${names.length} online: `)) reply(ctx, b);
    },
  },
  {
    name: "find",
    minRole: "moderator",
    usage: ":find <user>",
    run(args, ctx) {
      if (args.length !== 1) return usage(ctx, this);
      const target = resolveTarget(ctx, args[0]);
      if (target) reply(ctx, `${target.session.accountName} is in ${target.session.roomName}`);
    },
  },
];
