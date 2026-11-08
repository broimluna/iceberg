// Staff command pieces that don't need servers.
import { makeChecker } from "./lib/harness.ts";
import { Session } from "../smartfox-server/src/session.ts";
import { handleCommand } from "../smartfox-server/src/commands/index.ts";
import { mute, mutedUntil } from "../smartfox-server/src/mutes.ts";

const { check, finish } = makeChecker();
const ctxFor = (session: Session) => {
  const sent: unknown[] = [];
  return { ctx: { session, peer: "test", send: (p: unknown) => sent.push(p) } as any, sent };
};

{
  // Until the identity lookup answers, a session is a player, so its
  // commands are ordinary chat.
  const { ctx, sent } = ctxFor(new Session());
  check(handleCommand(":online", ctx) === false && sent.length === 0, "a session whose role isn't known yet can't run commands");
}
{
  const s = new Session();
  s.role = "admin";
  s.accountName = "admin";
  const { ctx } = ctxFor(s);
  for (const text of [":)", ":D", ":P", ":D hi", ": hi", "::", ":x"]) check(handleCommand(text, ctx) === false, `staff "${text}" is chat`);
  check(handleCommand("  :help", ctx) === true, "leading spaces are ignored");
  check(handleCommand(":HELP", ctx) === true, "command names ignore case");
}
{
  // Mutes follow the signed swid, which is known at login, so a muted
  // player who reconnects is muted before the account lookup answers.
  const s = new Session();
  s.swid = "{unit-muted}";
  mute({ swid: s.swid, accountName: "Muted" }, 5, "admin");
  check(mutedUntil(s) !== undefined, "a reconnecting session is muted before its account is known");
}
finish();
