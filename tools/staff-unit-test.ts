// Staff command pieces that don't need servers.
import { makeChecker } from "./lib/harness.ts";
import { Session } from "../smartfox-server/src/session.ts";
import { handleCommand } from "../smartfox-server/src/commands/index.ts";

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
finish();
