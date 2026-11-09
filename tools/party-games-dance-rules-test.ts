// Dance Battle rules (smartfox-server/src/party-games/dance-rules.ts), pure.
import { makeChecker } from "./lib/harness.ts";
import { getPartyGame } from "../smartfox-server/src/party-games/definitions.ts";
import { scorePlayer, teamRoundScore, outcomeFor, sequenceSetFor, decide, pickMoves, type SequenceSet } from "../smartfox-server/src/party-games/dance-rules.ts";

const { check, finish } = makeChecker();
const near = (a: number, b: number) => Math.abs(a - b) < 1e-9;

check(scorePlayer([1, 2, 3], [1, 2, 3]) === 1, "all correct scores 1");
check(near(scorePlayer([1, 9, 3], [1, 2, 3]), 2 / 3), "one wrong of three scores 2/3");
check(scorePlayer([], [1, 2, 3]) === 0, "no moves scores 0");
check(near(scorePlayer([1, 2], [1, 2, 3]), 2 / 3), "missing moves count as wrong");
check(scorePlayer([1, 2, 3, 3, 3], [1, 2, 3]) === 1, "extra moves are ignored");
check(scorePlayer([1], []) === 0, "an empty sequence scores 0, not NaN");

check(teamRoundScore([1, 0.5]) === 0.75, "a team's round score is the mean");
check(teamRoundScore([]) === 0, "an empty team scores 0");

check(outcomeFor([1, 9], [1, 2, 3], 19).join() === "1,19,19", "outcome keeps correct moves, failure id for wrong and missing");
check(outcomeFor([1, 2, 3, 3], [1, 2, 3], 19).join() === "1,2,3", "outcome is as long as the sequence");

const sets = (getPartyGame(3)!.gameData as { DanceSequenceSets: SequenceSet[] }).DanceSequenceSets;
check(sequenceSetFor(sets, 2).SequenceLength === 6 && sequenceSetFor(sets, 0).SequenceLength === 3, "round sets come from the game data (0-based)");
let threw = false;
try { sequenceSetFor(sets, 4); } catch { threw = true; }
check(threw, "a round past the last set throws");

check(decide(2, 1).placements.join() === "0,1" && decide(2, 1).paid, "team 0 ahead: placements 0,1, paid");
check(decide(1, 2).placements.join() === "1,0", "team 1 ahead: placements 1,0");
check(decide(1.5, 1.5).placements.join() === "0,0" && decide(1.5, 1.5).paid, "a tie: both placement 0, paid");
check(decide(1, 1.0004).placements.join() === "0,0", "a difference under 0.001 is a tie");
check(decide(0, 0).placements.join() === "0,0" && !decide(0, 0).paid, "0 vs 0 (nobody played) pays nobody");

check(pickMoves(5, [1, 2, 3], () => 0).join() === "1,1,1,1,1", "pickMoves uses the rng to index the pool");
const picked = pickMoves(7, [1, 2, 3]);
check(picked.length === 7 && picked.every((m) => [1, 2, 3].includes(m)), "pickMoves returns count moves from the pool");
finish("");
