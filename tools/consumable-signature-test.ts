// Consumable spend verification. The web API signs the UsedConsumable it
// returns from DELETE /consumable/v1/{type}; the game server only plays a
// con.use carrying that signature, for the same swid, once. The game
// server signs con.partial; the web API only stores a partial carrying
// that signature, for the same swid, once.
import { Database } from "bun:sqlite";
import { startWebApi, makeChecker } from "./lib/harness.ts";
import { createPlayer } from "./lib/mix-client.ts";
import { startGameServer, GameClient, sleep } from "./lib/sfs-client.ts";
import { SFSObjectWriter } from "../smartfox-server/src/sfs-wire.ts";

const { check, finish } = makeChecker();
const KEY = "test-join-key-" + Math.random().toString(36).slice(2);
process.env.JOIN_SIGNING_KEY = KEY;

const sfsSig = await import("../smartfox-server/src/consumable-signature.ts");
const apiSig = await import("../web-api/src/utils/consumableSignature.ts");

// ---- unit: signing and checking ----
{
  const swid = "{11111111-2222-3333-4444-555555555555}";
  const claims = (purpose: "use" | "partial", type = "PizzaGroup", partialCount = 1, sign = apiSig) => {
    const s = sign.signConsumable(purpose, swid, type, partialCount);
    return { swid, type, partialCount, goodUntil: s.goodUntil, signature: s.signature as unknown };
  };

  const u = claims("use");
  check(sfsSig.checkConsumable("use", u) === null, "web API use signature verifies on the game server");
  const p = claims("partial", "PizzaGroup", 3, sfsSig);
  check(apiSig.checkConsumable("partial", p) === null, "game server partial signature verifies on the web API");

  check(sfsSig.checkConsumable("use", { ...u, type: "FindFourGroup" }) === "bad signature", "tampered type -> bad signature");
  check(sfsSig.checkConsumable("use", { ...u, partialCount: 2 }) === "bad signature", "tampered partialCount -> bad signature");
  check(sfsSig.checkConsumable("use", { ...u, swid: "{other}" }) === "bad signature", "tampered swid -> bad signature");
  check(sfsSig.checkConsumable("use", { ...u, goodUntil: u.goodUntil + 1000 }) === "bad signature", "tampered goodUntil -> bad signature");
  check(sfsSig.checkConsumable("partial", u) === "bad signature", "use signature as partial -> bad signature");
  check(apiSig.checkConsumable("use", p) === "bad signature", "partial signature as use -> bad signature");
  check(sfsSig.checkConsumable("use", { ...u, signature: "" }) === "no signature", "empty signature -> no signature");
  check(sfsSig.checkConsumable("use", { ...u, signature: undefined }) === "no signature", "missing signature -> no signature");
  check(sfsSig.checkConsumable("use", { ...u, signature: "abc" }) === "bad signature", "signature without a nonce -> bad signature");
  check(sfsSig.checkConsumable("use", u, u.goodUntil + 1) === "expired", "past goodUntil -> expired");
  check(sfsSig.checkConsumable("use", u, u.goodUntil) === null, "at goodUntil -> still valid");
  check(u.goodUntil - Date.now() > 290_000 && u.goodUntil - Date.now() <= 300_000, "goodUntil is five minutes out");
  for (const bad of [-1, 1.5, "1"]) {
    const c = claims("use", "PizzaGroup", 1);
    check(sfsSig.checkConsumable("use", { ...c, partialCount: bad }) === "bad signature", `partialCount ${JSON.stringify(bad)} -> bad signature`);
  }
  check(sfsSig.checkConsumable("use", { ...u, type: "" }) === "bad signature", "empty type -> bad signature");
  const a = apiSig.signConsumable("use", swid, "PizzaGroup", 0, 1000);
  const b = apiSig.signConsumable("use", swid, "PizzaGroup", 0, 1000);
  check(a.signature !== b.signature, "same fields sign differently (nonce)");

  // claimsFrom reads a SignedResponse<UsedConsumable>.
  const signed = { goodUntil: u.goodUntil, swid, signature: u.signature, data: { type: "PizzaGroup", partialCount: 1 } };
  check(sfsSig.checkConsumable("use", sfsSig.claimsFrom(signed)) === null, "claimsFrom reads a SignedResponse");
  check(sfsSig.checkConsumable("use", sfsSig.claimsFrom("nonsense")) === "no signature", "claimsFrom on a non-object -> no signature");

  // Only the canonical encoding verifies, so one signature can't be
  // rewritten into several strings that each pass the replay set.
  const sig = u.signature as string;
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const last = sig.at(-1)!;
  const sameBytes = sig.slice(0, -1) + alphabet[alphabet.indexOf(last) ^ 1];
  check(Buffer.from(sameBytes.split(".")[1]!, "base64url").equals(Buffer.from(sig.split(".")[1]!, "base64url")), "(the variant decodes to the same MAC bytes)");
  check(sfsSig.checkConsumable("use", { ...u, signature: sameBytes }) === "bad signature", "non-canonical MAC encoding -> bad signature");
  check(sfsSig.checkConsumable("use", { ...u, signature: sig + "=" }) === "bad signature", "padded MAC -> bad signature");
  check(sfsSig.checkConsumable("use", { ...u, signature: "x|y." + sig.split(".")[1] }) === "bad signature", "malformed nonce -> bad signature");
  const far = apiSig.signConsumable("use", swid, "PizzaGroup", 0, Date.now() + 3_600_000);
  check(sfsSig.checkConsumable("use", { swid, type: "PizzaGroup", partialCount: 0, ...far }) === "bad signature", "goodUntil beyond five minutes -> bad signature");
  const skewed = apiSig.signConsumable("use", swid, "PizzaGroup", 0, Date.now() + 20_000);
  check(sfsSig.checkConsumable("use", { swid, type: "PizzaGroup", partialCount: 0, ...skewed }) === null, "a signer clock 20 s ahead is tolerated");
  let threw = false;
  try { apiSig.signConsumable("use", swid, "Pizza|Group", 0); } catch { threw = true; }
  check(threw, "signing a type containing | throws");

  // Replay set.
  check(sfsSig.claimConsumable(u.signature as string, u.goodUntil) === true, "first claim succeeds");
  check(sfsSig.claimConsumable(u.signature as string, u.goodUntil) === false, "second claim of the same signature fails");
  const t0 = 1_000_000;
  for (let i = 0; i < 20; i++) sfsSig.claimConsumable(`old-${i}`, t0 + 10, t0);
  const before = sfsSig.replaySize();
  sfsSig.claimConsumable("fresh", Date.now() + 300_000, Date.now());
  check(before >= 21 && sfsSig.replaySize() <= before - 20 + 1, `expired entries are pruned (${before} -> ${sfsSig.replaySize()})`);
}

// ---- web API: signed uses, no use without stock, verified partials ----
const api = await startWebApi({ env: { ALLOW_SWID_AUTH: "1", JOIN_SIGNING_KEY: KEY } });
const SWID_A = "{a1000000-0000-0000-0000-00000000000a}";
const SWID_B = "{b1000000-0000-0000-0000-00000000000b}";
await createPlayer(api.base, api.dbPath, SWID_A, "SigTesterA");
await createPlayer(api.base, api.dbPath, SWID_B, "SigTesterB");

const auth = (swid: string) => ({ Authorization: "Basic " + btoa(`${swid}:x`), "Content-Type": "application/json" });
const buy = (swid: string, type: string, n = 1) => fetch(`${api.base}/consumable/v1/${type}/${n}`, { method: "PUT", headers: auth(swid) });
const spend = (swid: string, type: string) => fetch(`${api.base}/consumable/v1/${type}`, { method: "DELETE", headers: auth(swid) });
const storePartial = (swid: string, body: unknown) =>
  fetch(`${api.base}/consumable/v1/partial`, { method: "POST", headers: auth(swid), body: JSON.stringify(body) });
async function stock(swid: string, type: string): Promise<{ itemCount: number; partialCount: number }> {
  const inv = await (await fetch(`${api.base}/consumable/v1`, { headers: auth(swid) })).json();
  return inv.data.inventoryMap[type] ?? { itemCount: 0, partialCount: 0 };
}
const partialBody = (swid: string, type: string, partialCount: number) => {
  const s = sfsSig.signConsumable("partial", swid, type, partialCount);
  return { goodUntil: s.goodUntil, signature: s.signature, swid, data: { type, partialCount } };
};

{
  const coinsOf = async (swid: string) => {
    const db = new Database(api.dbPath, { readonly: true });
    const row = db.query("SELECT coins FROM player_assets a JOIN player_identity i ON i.username = a.username WHERE i.swid = ?").get(swid) as any;
    db.close();
    return row?.coins as number | undefined;
  };
  await stock(SWID_A, "PizzaGroup"); // creates the player's assets row
  const c0 = await coinsOf(SWID_A);
  const neg = await buy(SWID_A, "PizzaGroup", -100);
  check(neg.status === 400 && await coinsOf(SWID_A) === c0 && (await stock(SWID_A, "PizzaGroup")).itemCount === 0, `buying a negative count -> 400, coins unchanged (${neg.status}, ${c0} -> ${await coinsOf(SWID_A)})`);
  const tooMany = await buy(SWID_A, "PizzaGroup", 100000);
  const tooManyBody = await tooMany.json().catch(() => null);
  check(tooMany.status === 400 && tooManyBody?.code === 707 && await coinsOf(SWID_A) === c0, `buying more than you can afford -> 400 code 707, coins unchanged (${tooMany.status}, ${JSON.stringify(tooManyBody)})`);
  {
    await stock(SWID_B, "PizzaGroup"); // creates the assets row
    const db = new Database(api.dbPath);
    db.run("UPDATE player_assets SET coins = 0 WHERE username = (SELECT username FROM player_identity WHERE swid = ?)", [SWID_B]);
    db.close();
    const broke = await buy(SWID_B, "PizzaGroup", 1);
    check(broke.status === 400 && (await coinsOf(SWID_B)) === 0, `a player with 0 coins can't buy (${broke.status}, ${await coinsOf(SWID_B)})`);
  }
  await buy(SWID_A, "PizzaGroup", 1);
  const r = await spend(SWID_A, "PizzaGroup");
  const used = await r.json();
  check(r.status === 200 && sfsSig.checkConsumable("use", sfsSig.claimsFrom(used)) === null, `spend -> 200 with a valid use signature (${r.status})`);
  check(used.swid === SWID_A && used.data?.type === "PizzaGroup" && used.data?.partialCount === 0, `use response carries swid and data (${JSON.stringify(used.data)})`);

  const again = await spend(SWID_A, "PizzaGroup");
  const againBody = await again.json().catch(() => null);
  check(again.status === 400 && againBody?.code === "CONSUMABLE_NOT_OWNED", `spend with none left -> 400 CONSUMABLE_NOT_OWNED (${again.status})`);
  const left = await stock(SWID_A, "PizzaGroup");
  check(left.itemCount === 0 && left.partialCount === 0, `stock unchanged by the refused spend (${JSON.stringify(left)})`);
  check((await spend(SWID_A, "FindFourGroup")).status === 400, "spend of a never-owned type -> 400");

  const good = partialBody(SWID_A, "PizzaGroup", 3);
  check((await storePartial(SWID_A, good)).status === 200, "signed partial -> 200");
  check((await stock(SWID_A, "PizzaGroup")).partialCount === 3, "signed partial is stored");
  const fromPartial = await (await spend(SWID_A, "PizzaGroup")).json();
  check(fromPartial.data?.partialCount === 3 && sfsSig.checkConsumable("use", sfsSig.claimsFrom(fromPartial)) === null,
    `spend with only a partial left -> signed use of partialCount 3 (${JSON.stringify(fromPartial.data)})`);
  check((await stock(SWID_A, "PizzaGroup")).partialCount === 0, "the partial is cleared once spent");

  const refusedPartial = async (label: string, swid: string, body: unknown) => {
    const res = await storePartial(swid, body);
    const b = await res.json().catch(() => null);
    const s = await stock(swid, "PizzaGroup");
    check(res.status === 400 && b?.code === "BAD_SIGNATURE" && s.partialCount === 0, `${label} -> 400, nothing stored (${res.status}, ${JSON.stringify(s)})`);
  };
  await refusedPartial("replayed partial", SWID_A, good);
  await refusedPartial("tampered partial count", SWID_A, { ...partialBody(SWID_A, "PizzaGroup", 1), data: { type: "PizzaGroup", partialCount: 6 } });
  await refusedPartial("another player's partial", SWID_B, partialBody(SWID_A, "PizzaGroup", 2));
  const useSigned = apiSig.signConsumable("use", SWID_A, "PizzaGroup", 2);
  await refusedPartial("use signature as a partial", SWID_A, { ...useSigned, swid: SWID_A, data: { type: "PizzaGroup", partialCount: 2 } });
  await refusedPartial("unsigned partial", SWID_A, { goodUntil: 0, signature: "", swid: SWID_A, data: { type: "PizzaGroup", partialCount: 6 } });
}

// ---- game server: con.use needs a signed, unused spend for this player ----
const sfs = await startGameServer(api, KEY);
try {
  const A = new GameClient(api, sfs.port, "{a2000000-0000-0000-0000-0000000000a1}", "SigUserA");
  const B = new GameClient(api, sfs.port, "{b2000000-0000-0000-0000-0000000000b1}", "SigUserB");
  await A.connect(); await B.connect();
  check(A.myId > 0 && B.myId > 0, `both logged in (${A.myId}, ${B.myId})`);
  await sleep(150);

  // A one-shot is "played" when the rest of the room gets con.use from A.
  const playedBy = (c: GameClient) => B.extOf("con.use").filter((p) => p.senderId?.value === c.myId).length;
  const refusedLog = (reason: string) => sfs.logs().split("\n").filter((l) => l.includes(`con.use refused (${reason})`)).length;
  const attempt = async (who: GameClient, json: string) => { B.clear(); who.sendUse(json); await sleep(150); return playedBy(who); };

  const first = await A.spend("Firework");
  check(await attempt(A, first) === 1, "a signed spend plays");
  check(await attempt(A, first) === 0 && refusedLog("replayed") === 1, "the same con.use again -> refused (replayed)");

  const fresh = await A.spend("Firework");
  const tampered = JSON.parse(fresh); tampered.data.type = "Pinata";
  check(await attempt(A, JSON.stringify(tampered)) === 0 && refusedLog("bad signature") >= 1, "tampered type -> refused (bad signature)");
  check(await attempt(A, fresh) === 1, "the genuine payload still plays after a tampered copy");

  const unsigned = JSON.stringify({ goodUntil: 0, signature: "", swid: A.swid, data: { type: "Firework", partialCount: 0 } });
  check(await attempt(A, unsigned) === 0 && refusedLog("no signature") === 1, "unsigned con.use -> refused (no signature)");

  const forB = await A.spend("Firework");
  B.clear(); A.clear(); B.sendUse(forB); await sleep(150);
  check(A.extOf("con.use").filter((p) => p.senderId?.value === B.myId).length === 0 && refusedLog("wrong swid") === 1, "another player's spend -> refused (wrong swid)");
  check(await attempt(A, forB) === 1, "the owner can still use it after someone else tried");

  const p = sfsSig.signConsumable("partial", A.swid, "Firework", 0);
  check(await attempt(A, JSON.stringify({ ...p, swid: A.swid, data: { type: "Firework", partialCount: 0 } })) === 0, "a partial signature as con.use -> refused");

  // An invitation put away unaccepted is gone: no partial (it would make the
  // next spend free).
  A.setCon("FindFourGroup"); await sleep(100);
  await A.use("FindFourGroup"); await sleep(150);
  check(B.varsOf(A.myId).some((v) => v.con === "consum:FindFourGroup"), "invitation held out");
  A.clear(); A.setCon(null); await sleep(200);
  check(A.extOf("con.partial").length === 0, `putting an invitation away sends no con.partial (${A.extOf("con.partial").length})`);

  // Tray: hold out, B takes one, put away -> signed con.partial for 5,
  // which the web API stores; the next spend returns it and the tray comes
  // back with 5.
  const actionCount = () => {
    const v = B.varsOf(A.myId).map((x) => x.con_prop).filter((x) => typeof x === "string").at(-1) as string | undefined;
    return v ? JSON.parse(v).actionCount : undefined;
  };
  A.setCon("PizzaGroup"); await sleep(100);
  B.clear(); await A.use("PizzaGroup"); await sleep(150);
  check(actionCount() === 6, `tray held out with 6 (${actionCount()})`);
  B.interactWith(A.sid); await sleep(200);
  check(actionCount() === 5, `B took one, 5 left (${actionCount()})`);
  B.setCon(null); await sleep(100);
  A.clear(); A.setCon(null); await sleep(200);
  const partialJson = A.extOf("con.partial")[0]?.data?.value as string | undefined;
  const partial = partialJson ? JSON.parse(partialJson) : undefined;
  check(partial?.data?.partialCount === 5 && partial?.swid === A.swid && apiSig.checkConsumable("partial", apiSig.claimsFrom(partial)) === null,
    `con.partial is signed for A with 5 (${partialJson})`);
  const stored = await fetch(`${api.base}/consumable/v1/partial`, { method: "POST", headers: A.auth(), body: partialJson ?? "{}" });
  check(stored.status === 200 && (await stock(A.swid, "PizzaGroup")).partialCount === 5, `the web API stores it (${stored.status})`);
  A.setCon("PizzaGroup"); await sleep(100);
  B.clear();
  const again = JSON.parse(await A.use("PizzaGroup")); await sleep(150);
  check(again.data?.partialCount === 5 && actionCount() === 5, `next spend returns the partial and the tray comes back with 5 (${again.data?.partialCount}, ${actionCount()})`);

  // Leaving the room hands the held tray to the next room (zone.transfer),
  // so putting it away afterwards must not also store it as a partial.
  check(actionCount() === 5, "A holds the tray again before leaving");
  A.clear(); A.ext13("zone.logout", new SFSObjectWriter()); await sleep(150);
  check(A.extOf("zone.transfer").length === 1, "zone.transfer sent");
  A.setCon(null); await sleep(200);
  check(A.extOf("con.partial").length === 0, `putting the tray away after zone.logout sends no con.partial (${A.extOf("con.partial").length})`);
} finally {
  sfs.stop();
  await api.stop();
}
finish(sfs.logs() + api.logs());
