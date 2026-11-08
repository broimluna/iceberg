// Held items (trays and the items taken from them) and the client's own
// "con" changes. The client turns user variable updates into held-item
// events (SmartFoxGameServerClient.broadcastUserVariables): "con" changed
// while "con_prop" is set = a new PlayerHeldItem (SERVER_ITEM_ADDED), which
// re-adds the ServerObjectItemData and re-runs every ComponentAddedEvent
// handler. So while the server has "con_prop" set on a player, their own
// "con" change must never reach any client alone.
import { startWebApi, makeChecker } from "./lib/harness.ts";
import { startGameServer, GameClient, sleep } from "./lib/sfs-client.ts";

const { check, finish } = makeChecker();
const KEY = "test-join-key-" + Math.random().toString(36).slice(2);
process.env.JOIN_SIGNING_KEY = KEY;

type HeldEvent = { kind: "added" | "changed" | "removed" | "equipped" | "dequipped"; type?: string };

// One observer's view of one user's held item, each update packet applied
// as its own frame (the worst case: real clients may merge some).
// Only events after `since` (ms) are returned; state builds from all.
function heldEvents(observer: GameClient, user: GameClient, since = 0): HeldEvent[] {
  const state: Record<string, unknown> = {};
  const events: HeldEvent[] = [];
  const self = observer === user;
  for (const { vars, at } of observer.updates.filter((x) => x.u === user.myId)) {
    Object.assign(state, vars);
    if (at < since) continue;
    const con = state.con as string | null | undefined;
    const conProp = state.con_prop as string | null | undefined;
    if ("con" in vars) {
      if (con == null) {
        events.push({ kind: "con_prop" in vars && conProp == null ? "removed" : "dequipped" });
      } else if (conProp != null) {
        events.push({ kind: "added", type: con.split(":")[1] });
      } else if (!self) {
        events.push({ kind: "equipped", type: con.split(":")[1] });
      }
    } else if ("con_prop" in vars && con != null) {
      events.push({ kind: "changed", type: con.split(":")[1] });
    }
  }
  return events;
}

// An "added" while the observer still has a live item for that user.
function reAdds(events: HeldEvent[]): HeldEvent[] {
  let live = false;
  const out: HeldEvent[] = [];
  for (const e of events) {
    if (e.kind === "added") {
      if (live) out.push(e);
      live = true;
    } else if (e.kind === "removed") live = false;
  }
  return out;
}
const show = (events: HeldEvent[]) => events.map((e) => e.kind + (e.type ? `(${e.type})` : "")).join(" ");

const api = await startWebApi({ env: { ALLOW_SWID_AUTH: "1", JOIN_SIGNING_KEY: KEY } });
const sfs = await startGameServer(api, KEY);
try {
  const A = new GameClient(api, sfs.port, "{a3000000-0000-0000-0000-0000000000a1}", "EchoUserA");
  const B = new GameClient(api, sfs.port, "{b3000000-0000-0000-0000-0000000000b1}", "EchoUserB");
  await A.connect(); await B.connect();
  check(A.myId > 0 && B.myId > 0, `both logged in (${A.myId}, ${B.myId})`);
  await sleep(150);

  // A holds out a cake; B takes a slice and eats it, then pulls out their
  // own consumable before the eaten slice is cleared.
  A.setCon("FluffyCakeTray"); await sleep(100);
  await A.use("FluffyCakeTray"); await sleep(150);
  B.interactWith(A.sid); await sleep(200);
  check(heldEvents(A, B).some((e) => e.kind === "added" && e.type === "FluffyCakeServerAdded"), `B took a slice (A sees: ${show(heldEvents(A, B))})`);
  B.interactWith(B.sid); await sleep(200);
  check(heldEvents(A, B).some((e) => e.kind === "changed"), "B ate it");
  B.setCon("PizzaGroup"); await sleep(300);
  for (const [name, observer] of [["A", A], ["B", B]] as const) {
    const events = heldEvents(observer, B);
    check(reAdds(events).length === 0, `${name} sees no second item added for B while the slice is live (${show(events)})`);
  }
  check(heldEvents(A, B).at(-1)?.kind === "equipped", `A ends with PizzaGroup equipped on B (${show(heldEvents(A, B))})`);
  check(heldEvents(A, B).some((e) => e.kind === "removed"), "the slice is removed for the room");

  // Re-sending the same "con" while holding the tray changes nothing.
  B.setCon(null); await sleep(100);
  let since = Date.now();
  A.setCon("FluffyCakeTray"); await sleep(200);
  for (const [name, observer] of [["A", A], ["B", B]] as const) {
    const events = heldEvents(observer, A, since);
    check(events.length === 0, `${name} sees nothing when A re-sends the tray it holds (${show(events)})`);
  }

  // Putting the tray away still removes it everywhere.
  since = Date.now();
  A.setCon(null); await sleep(200);
  const away = heldEvents(B, A, since);
  check(away.some((e) => e.kind === "removed") && !away.some((e) => e.kind === "added"), `putting the tray away removes it (${show(away)})`);
} finally {
  sfs.stop();
  await api.stop();
}
finish();
