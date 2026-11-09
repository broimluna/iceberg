// Scavenger Hunt rules (smartfox-server/src/party-games/scavenger-hunt-rules.ts).
import { makeChecker } from "./lib/harness.ts";
import { validateDrop, validatePickup, decideWinner, parseItemId, MAX_DROP_STEP, MIN_MARBLE_GAP, PICKUP_RADIUS } from "../smartfox-server/src/party-games/scavenger-hunt-rules.ts";

const { check, finish } = makeChecker();
check(MAX_DROP_STEP === 3 && MIN_MARBLE_GAP === 1 && PICKUP_RADIUS === 6, "constants");

check(validateDrop([0, 0, 0], undefined, [], 3) === "ok", "first drop, no history: ok");
check(validateDrop([0, 0, 0], undefined, [[5, 0, 0], [6, 0, 0], [7, 0, 0]], 3) === "max", "a 4th marble: max");
check(validateDrop([NaN, 0, 0], undefined, [], 3) === "bad-position", "NaN: bad-position");
check(validateDrop([Infinity, 0, 0], undefined, [], 3) === "bad-position", "Infinity: bad-position");
check(validateDrop([0, 0] as any, undefined, [], 3) === "bad-position", "2-element array: bad-position");
check(validateDrop([3.1, 0, 0], [0, 0, 0], [], 3) === "too-far", "3.1 m from the last position: too-far");
check(validateDrop([3, 0, 0], [0, 0, 0], [], 3) === "ok", "exactly 3 m: ok");
check(validateDrop([0.9, 0, 0], undefined, [[0, 0, 0]], 3) === "too-close", "0.9 m from a marble: too-close");
check(validateDrop([1, 0, 0], undefined, [[0, 0, 0]], 3) === "ok", "1.0 m from a marble: ok");

check(validatePickup(undefined, [0, 0, 0]) === "unknown-position", "no finder position");
check(validatePickup([6.1, 0, 0], [0, 0, 0]) === "too-far", "6.1 m: too-far");
check(validatePickup([6, 0, 0], [0, 0, 0]) === "ok", "6 m: ok");

check(decideWinner(0, 0) === "finder", "nothing hidden: finder");
check(decideWinner(3, 3) === "finder", "all found: finder");
check(decideWinner(3, 2) === "hider", "one left: hider");
check(decideWinner(1, 0) === "hider", "none found: hider");

check(parseItemId({ ItemId: 2 }) === 2 && parseItemId({ ItemId: 0 }) === 0, "valid ids");
for (const bad of [{ ItemId: "2" }, { ItemId: -1 }, { ItemId: 1.5 }, { ItemId: 2 ** 60 }, null, {}, 5, "x"]) {
  check(parseItemId(bad) === undefined, `bad id ${JSON.stringify(bad)}`);
}
finish();
