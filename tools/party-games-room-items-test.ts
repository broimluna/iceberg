// Room MMO items (smartfox-server/src/party-games/room-items.ts): lobby and
// game items reach everyone in the room, variable changes send only the
// changed variable, removal sends the id, and a late joiner gets a snapshot.
import { makeChecker } from "./lib/harness.ts";
import { makePlayer, decodeItemTuple, decodeItemVars } from "./lib/party-fakes.ts";
import { addRoomItem, setRoomItemVar, removeRoomItem, sendRoomItemsSnapshot, roomItemsIn } from "../smartfox-server/src/party-games/room-items.ts";
import type { SFSValue } from "../smartfox-server/src/sfs-wire.ts";

const { check, finish } = makeChecker();
const ROOM = "Alpine:en_US:Town::1.15.1;offline;2026-11-08;NONE";
const A = makePlayer("a", ROOM), B = makePlayer("b", ROOM), C = makePlayer("c", "Alpine:en_US:Other::1.15.1;offline;2026-11-08;NONE");

const item = addRoomItem(ROOM, [16, 0.5, -10], { category: { type: "int", value: 6 }, int_a: { type: "int", value: 3 }, ttl: { type: "double", value: 60 }, score: { type: "string", value: "{}" } });
for (const p of [A, B]) {
  const add = p.mmo.find((m) => m.a === 30 && m.p.q);
  const t = add ? decodeItemTuple((add.p.q!.value as SFSValue[])[0]!) : undefined;
  check(!!t && t.id === item.itemId && t.vars.category === 6 && t.vars.int_a === 3 && t.vars.ttl === 60 && t.vars.score === "{}" && t.position.join() === "16,0.5,-10",
    `${p.session.userName} receives the added item with its variables and position (${JSON.stringify(t)})`);
}
check(C.mmo.length === 0, "a player in another room receives nothing");
check(roomItemsIn(ROOM).length === 1 && roomItemsIn(ROOM)[0] === item, "the item is listed for its room");

A.clear(); B.clear();
setRoomItemVar(item, "score", { type: "string", value: '{"Players":[]}' });
for (const p of [A, B]) {
  const m = p.mmo.find((x) => x.a === 1007);
  const vars = m ? decodeItemVars(m.p.v!.value as SFSValue[]) : undefined;
  check(!!m && m.p.i!.value === item.itemId && m.p.r!.value === 1 && Object.keys(vars!).join() === "score" && vars!.score === '{"Players":[]}',
    `${p.session.userName} receives only the changed variable (${JSON.stringify(vars)})`);
}
check(item.vars.get("score")?.value === '{"Players":[]}', "the item remembers its latest value");

const late = makePlayer("late", ROOM);
sendRoomItemsSnapshot({ session: late.session, peer: "late", send: late.entry.send }, ROOM);
const snap = late.mmo.find((m) => m.a === 30 && m.p.q);
const st = snap ? decodeItemTuple((snap.p.q!.value as SFSValue[])[0]!) : undefined;
check(!!st && st.id === item.itemId && st.vars.score === '{"Players":[]}', "a joiner's snapshot carries the item's current variables");

A.clear(); B.clear();
removeRoomItem(item);
for (const p of [A, B]) {
  const m = p.mmo.find((x) => x.a === 30 && x.p.n);
  check(!!m && (m.p.n!.value as number[]).join() === String(item.itemId), `${p.session.userName} is told the item is gone`);
}
check(roomItemsIn(ROOM).length === 0, "the item is no longer listed");

const second = addRoomItem(ROOM, [0, 0, 0], {});
check(second.itemId !== item.itemId, "item ids are not reused");
finish("");
