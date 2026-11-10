import type { HandlerContext } from "../handlers/context.ts";
import { hasRole } from "./roles.ts";
import { replyError } from "./reply.ts";
import type { CommandDef } from "./common.ts";
import { commands as info } from "./info.ts";
import { commands as moderation } from "./moderation.ts";
import { commands as economy } from "./economy.ts";
import { commands as serverAdmin } from "./server-admin.ts";
import { commands as roleAdmin } from "./role-admin.ts";
import { commands as partyGames } from "./party-games.ts";
import { commands as islandTargets } from "./island-targets.ts";
import { commands as parties } from "./parties.ts";

// Staff chat commands: chat starting with ":" and two or more letters, from a
// moderator or admin. Anything else, including every player's chat and
// emoticons like ":)" or ":D", is ordinary chat.

// Built on first use: the command files import shared helpers that would
// otherwise form an import cycle with this table.
let table: CommandDef[] | undefined;
export function commandTable(): CommandDef[] {
  return (table ??= [...info, ...moderation, ...economy, ...serverAdmin, ...roleAdmin, ...partyGames, ...islandTargets, ...parties]);
}

/** Runs a staff command; false means the text is ordinary chat. */
export function handleCommand(text: string, ctx: HandlerContext): boolean {
  const { session } = ctx;
  if (!hasRole(session, "moderator")) return false;
  const trimmed = text.trim();
  // At least two letters, so emoticons like :D and :P stay chat; names may
  // have hyphenated parts (:admin-alert).
  if (!/^:[A-Za-z]{2,}(-[A-Za-z]+)*(\s|$)/.test(trimmed)) return false;
  const [word, ...args] = trimmed.slice(1).split(/\s+/);
  const name = word!.toLowerCase();
  const def = commandTable().find((c) => c.name === name);
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
