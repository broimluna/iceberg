// Consumable spend verification. The web API signs the UsedConsumable it
// returns from DELETE /consumable/v1/{type}; the game server only plays a
// con.use carrying that signature, for the same swid, once. The game
// server signs con.partial; the web API only stores a partial carrying
// that signature, for the same swid, once.
import { makeChecker } from "./lib/harness.ts";

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

finish();
