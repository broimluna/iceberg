// Fish Bucket rules (template 1), pure. The server owns the deck: each card
// is a fish delta (positive = fish, negative = squid ink).
interface Deck {
  Cards: { FishDelta: number; Quantity: number }[];
  MinPlayerCount: number;
  MaxPlayerCount: number;
}

// A shuffled deck for `playerCount` players. The template has several decks
// per player count; one matching deck is picked at random.
export function buildDeck(gameData: Record<string, unknown>, playerCount: number, rng: () => number = Math.random): number[] {
  const all = (gameData.CardDecks as Deck[] | undefined) ?? [];
  const matching = all.filter((d) => d.MinPlayerCount <= playerCount && playerCount <= d.MaxPlayerCount);
  if (matching.length === 0) throw new Error(`no Fish Bucket deck for ${playerCount} players`);
  const chosen = matching[Math.min(matching.length - 1, Math.floor(rng() * matching.length))]!;
  const cards = chosen.Cards.flatMap((c) => Array.from({ length: c.Quantity }, () => c.FishDelta));
  for (let i = cards.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [cards[i], cards[j]] = [cards[j]!, cards[i]!];
  }
  return cards;
}

// The client clamps a bucket at 0 fish; so does the server.
export function applyDelta(score: number, delta: number): number {
  return Math.max(score + delta, 0);
}

// Dense rank per player (0 = most fish); ties share a placement.
export function placementsFromScores(scores: number[]): number[] {
  const distinct = [...new Set(scores)].sort((a, b) => b - a);
  return scores.map((s) => distinct.indexOf(s));
}
