import { setRole } from "../webapi-client.ts";
import { getAll } from "../session-registry.ts";
import type { HandlerContext } from "../handlers/context.ts";
import type { Role } from "./roles.ts";
import { reply, replyError, usage, type CommandDef } from "./common.ts";

// :promote / :demote write the role in the web API, so they work for
// offline players too; an online player's new role applies immediately.
async function changeRole(ctx: HandlerContext, name: string, role: Role): Promise<void> {
  if (name === ctx.session.accountName) {
    replyError(ctx, `You can't ${role === "player" ? "demote" : "promote"} yourself`);
    return;
  }
  const result = await setRole(name, role);
  if (!result.ok) {
    if (result.reason === "unknown-user") replyError(ctx, `No account named ${name}`);
    else if (result.reason === "config-admin") replyError(ctx, `${name} is an admin in STAFF_ADMINS`);
    else replyError(ctx, "Couldn't change the role");
    return;
  }
  for (const entry of getAll()) {
    if (entry.session.accountName === result.username && entry.session.signedLogin) entry.session.role = role;
  }
  reply(ctx, `${result.username} is now ${role}`);
}

export const commands: CommandDef[] = [
  {
    name: "promote",
    minRole: "admin",
    usage: ":promote <user> moderator|admin",
    async run(args, ctx) {
      const role = args[1]?.toLowerCase();
      if (args.length !== 2 || (role !== "moderator" && role !== "admin")) return usage(ctx, this);
      await changeRole(ctx, args[0]!, role);
    },
  },
  {
    name: "demote",
    minRole: "admin",
    usage: ":demote <user>",
    async run(args, ctx) {
      if (args.length !== 1) return usage(ctx, this);
      await changeRole(ctx, args[0]!, "player");
    },
  },
];
