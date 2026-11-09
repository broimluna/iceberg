// Fish Bucket rules (smartfox-server/src/party-games/fish-bucket-rules.ts), pure.
import { makeChecker } from "./lib/harness.ts";
import { getPartyGame } from "../smartfox-server/src/party-games/definitions.ts";
import { buildDeck, applyDelta, placementsFromScores } from "../smartfox-server/src/party-games/fish-bucket-rules.ts";

const { check, finish } = makeChecker();
const gameData = getPartyGame(1)!.gameData;
type Deck = { Cards: { FishDelta: number; Quantity: number }[]; MinPlayerCount: number; MaxPlayerCount: number };
const decks = (gameData as { CardDecks: Deck[] }).CardDecks;
const expand = (d: Deck) => d.Cards.flatMap((c) => Array(c.Quantity).fill(c.FishDelta) as number[]).sort((a, b) => a - b).join();
const seeded = (seed: number) => () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);

for (const [players, total] of [[2, 18], [3, 27], [4, 36]] as const) {
  const deck = buildDeck(gameData, players, seeded(7));
  const candidates = decks.filter((d) => d.MinPlayerCount <= players && players <= d.MaxPlayerCount).map(expand);
  check(deck.length === total, `${players} players: ${total} cards`);
  check(candidates.includes([...deck].sort((a, b) => a - b).join()), `${players} players: the deck is one of the matching decks, expanded`);
}
let threw = 0;
for (const n of [1, 5]) try { buildDeck(gameData, n); } catch { threw++; }
check(threw === 2, "a player count with no deck throws");

// Pin the deck choice (first candidate) by rng: all rngs below 0.5 pick it, shuffling aside.
const a = buildDeck(gameData, 2, seeded(1)), b = buildDeck(gameData, 2, seeded(1)), c = buildDeck(gameData, 2, seeded(99));
check(a.join() === b.join(), "same rng gives the same order");
check(a.join() !== c.join(), "a different rng gives a different order");

check(applyDelta(0, -2) === 0 && applyDelta(5, -2) === 3 && applyDelta(1, 3) === 4, "scores never go below 0");
check(placementsFromScores([5, 9, 5, 0]).join() === "1,0,1,2", "dense placements, ties share");
check(placementsFromScores([0, 0]).join() === "0,0", "all tied is all first");
finish("");
