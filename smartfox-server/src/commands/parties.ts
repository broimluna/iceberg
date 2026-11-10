import { logSafe } from "../log-safe.ts";
import { fetchParty, setPartyOverride, type PartyState } from "../webapi-client.ts";
import { partyState, setPartyState } from "../parties.ts";
import { reply, replyError, usage, type CommandDef } from "./common.ts";

const nameOf = (key: string) => key.split("|")[1] ?? key;

function describe(s: PartyState): string {
  const mode = s.mode === "party" && s.party ? `party (${s.party})` : s.mode;
  return `Parties: ${mode}; active: ${s.active.length ? s.active.map(nameOf).join(", ") : "none"}`;
}

export const commands: CommandDef[] = [
  {
    name: "admin-party",
    minRole: "admin",
    usage: ":admin-party [<party>|auto|none]",
    async run(args, ctx) {
      if (args.length > 1) return usage(ctx, this);
      if (args.length === 0) {
        const state = (await fetchParty()) ?? partyState();
        if (state) reply(ctx, describe(state));
        else replyError(ctx, "Couldn't reach the web API");
        return;
      }
      const arg = args[0]!;
      const setBy = ctx.session.accountName ?? "unknown";
      const keyword = arg.toLowerCase();
      const body = keyword === "auto" || keyword === "none"
        ? { mode: keyword, setBy }
        : { mode: "party", party: arg, setBy };
      const result = await setPartyOverride(body);
      if (result.ok) {
        setPartyState(result.state);
        console.log(`[${new Date().toISOString()}] [PARTY] ${logSafe(ctx.session.accountName, 64)} set ${body.mode} ${logSafe(body.party ?? "", 40)}`.trimEnd());
        reply(ctx, `Party set. ${describe(result.state)}`);
      } else if (result.reason === "unknown-party") {
        replyError(ctx, `Unknown party "${logSafe(arg, 40)}". Parties: ${(result.valid ?? []).join(", ")}`);
      } else {
        replyError(ctx, "Couldn't reach the web API");
      }
    },
  },
];
