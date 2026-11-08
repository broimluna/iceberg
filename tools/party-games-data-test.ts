// Party game definitions (smartfox-server/data/party-games.json) and their
// lookups.
import { makeChecker } from "./lib/harness.ts";
import { getPartyGame, templateForTrigger, rewardFor } from "../smartfox-server/src/party-games/definitions.ts";

const { check, finish } = makeChecker();
const same = (x: unknown, y: unknown) => JSON.stringify(x) === JSON.stringify(y);

const ff = getPartyGame(2)!;
check(ff?.gameData.SequenceCountToWin === 4, "Find Four needs 4 in a row");
check(ff.minPlayers === 2 && ff.maxPlayers === 2, `Find Four is 2 players (${ff.minPlayers}-${ff.maxPlayers})`);
check(ff.playerProp === "FindFourGameServerAdded", `Find Four player prop (${ff.playerProp})`);
check(templateForTrigger("FindFourGroup") === 2, "FindFourGroup triggers template 2");
check(templateForTrigger("ScavengerHuntGroup") === 0, "ScavengerHuntGroup triggers template 0");
check(templateForTrigger("PizzaGroup") === undefined, "PizzaGroup triggers nothing");
check(same(rewardFor(ff, 0), { coins: 20, mascotXP: { AuntArctic: 15 } }), `first place reward ${JSON.stringify(rewardFor(ff, 0))}`);
check(same(rewardFor(ff, 1), { coins: 10, mascotXP: { AuntArctic: 10 } }), "second place reward");
check(rewardFor(ff, 4) === undefined, "no reward for an unlisted placement");
check(getPartyGame(99) === undefined, "unknown template");

finish();
