// Consumable spend verification. The web API signs the UsedConsumable it
// returns from DELETE /consumable/v1/{type}; the game server only plays a
// con.use carrying that signature, for the same swid, once. The game
// server signs con.partial; the web API only stores a partial carrying
// that signature, for the same swid, once.
import { startWebApi, makeChecker } from "./lib/harness.ts";
import { createPlayer } from "./lib/mix-client.ts";

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
const SWID_A = "{c0000000-0000-0000-0000-00000000000a}";
const SWID_B = "{c0000000-0000-0000-0000-00000000000b}";
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

await api.stop();
finish(api.logs());
