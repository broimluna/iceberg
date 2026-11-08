// Staff command pieces that don't need servers.
import { makeChecker } from "./lib/harness.ts";
import { Session } from "../smartfox-server/src/session.ts";
import { handleCommand } from "../smartfox-server/src/commands/index.ts";
import { mute, mutedUntil } from "../smartfox-server/src/mutes.ts";
import { restartMarks, formatDuration } from "../smartfox-server/src/commands/server-admin.ts";

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
{
  const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  check(eq(restartMarks(180), [180, 120, 60, 30, 10, 3]), `restartMarks(180) = ${restartMarks(180)}`);
  check(eq(restartMarks(45), [45, 30, 10, 3]), `restartMarks(45) = ${restartMarks(45)}`);
  check(eq(restartMarks(2), [2]), `restartMarks(2) = ${restartMarks(2)}`);
  check(eq(restartMarks(60), [60, 30, 10, 3]), `restartMarks(60) = ${restartMarks(60)}`);
  check(eq(restartMarks(600), [600, 540, 480, 420, 360, 300, 240, 180, 120, 60, 30, 10, 3]), `restartMarks(600) = ${restartMarks(600)}`);
  check(eq(restartMarks(90), [90, 60, 30, 10, 3]), `restartMarks(90) = ${restartMarks(90)}`);
  for (const [s, text] of [[180, "3 minutes"], [60, "1 minute"], [30, "30 seconds"], [1, "1 second"], [150, "2 minutes 30 seconds"], [61, "1 minute 1 second"]] as const) {
    check(formatDuration(s) === text, `formatDuration(${s}) = "${formatDuration(s)}"`);
  }
}
finish();
