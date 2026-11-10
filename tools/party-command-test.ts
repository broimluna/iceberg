// :admin-party end to end: permissions, replies, key forms, the override.
import { makeChecker } from "./lib/harness.ts";
import { startServers, Client, sleep } from "./lib/staff-client.ts";
import { calendar, activeParties } from "../web-api/src/services/parties.ts";

const { check, finish } = makeChecker();
const servers = await startServers();
const admin = new Client(servers, "{pc-admin}", "PcAdmin");
const player = new Client(servers, "{pc-player}", "PcPlayer");
await admin.account(); await player.account();
await servers.setStaffAdmins([admin.username]);
const state = async () => (await (await fetch(`${servers.api.base}/api/internal/party`, { headers: servers.api.internalHeaders() })).json()) as any;
const SAY = async (c: Client, text: string) => { admin.reset(); player.reset(); await c.chat(text); await sleep(500); };
const names = activeParties(calendar(), { mode: "auto" }, new Date()).map((e) => e.name);
const autoActive = names.length ? names.join(", ") : "none";

try {
  await admin.connect(); await player.connect();

  await SAY(admin, ":admin-party");
  check(admin.bubbles[0] === `Parties: auto; active: ${autoActive}`, `no args shows the state (${admin.bubbles[0]})`);

  await SAY(admin, ":admin-party CarWorld");
  check(admin.bubbles[0] === "Party set. Parties: party (55|carworld); active: carworld", `set by name, any case (${admin.bubbles[0]})`);
  await SAY(admin, ":admin-party 47");
  check(admin.bubbles[0] === "Party set. Parties: party (47|halloween2026); active: halloween2026", `set by id (${admin.bubbles[0]})`);
  await SAY(admin, ":admin-party 55|carworld");
  await SAY(admin, ":admin-party 47|halloween2026");
  check(admin.bubbles[0] === "Party set. Parties: party (47|halloween2026); active: halloween2026", `set by key (${admin.bubbles[0]})`);
  await SAY(admin, ":admin-party");
  check(admin.bubbles[0] === "Parties: party (47|halloween2026); active: halloween2026", "state without args after a change");

  await SAY(admin, ":admin-party nope");
  check(admin.errors[0]?.startsWith('Unknown party "nope". Parties:') === true && admin.errors[0].includes("carworld"), `unknown party lists the names (${admin.errors[0]?.slice(0, 80)})`);
  await SAY(admin, ":admin-party carworld extra");
  check(admin.errors[0] === "Usage: :admin-party [<party>|auto|none]", `extra words give the usage (${admin.errors[0]})`);
  check((await state()).party === "47|halloween2026", "refused commands changed nothing");

  await SAY(admin, ":admin-party NONE");
  check(admin.bubbles[0] === "Party set. Parties: none; active: none", `none, any case (${admin.bubbles[0]})`);
  await SAY(admin, ":admin-party auto");
  check(admin.bubbles[0] === `Party set. Parties: auto; active: ${autoActive}`, `auto (${admin.bubbles[0]})`);

  await SAY(player, ":admin-party carworld");
  const st = await state();
  check(st.mode === "auto" && player.errors.length === 0, "a player's :admin-party is plain chat and changes nothing");

  await admin.chat(":admin-party carworld"); await sleep(400);
  check(servers.api.logs().includes(`[PARTY] override set mode=party party=55|carworld by ${admin.username}`), "web API logs who set it");
  check(servers.sfsLog().includes("[PARTY] party state: mode=party"), "game server logs the new state");
} finally {
  await servers.stop();
}
finish(servers.sfsLog());
