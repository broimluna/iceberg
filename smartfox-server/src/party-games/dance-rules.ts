// Dance Battle rules, pure. Scoring follows the original Java extension's
// DanceBattleSession: a player's round score is correct moves / sequence
// length, a team's round score is the mean of its players, team totals add
// up over the rounds. Placements follow the client's PartyGameEndPlacement
// (FIRST = 0 wins, SECOND = 1).

// One entry of the template's gameData.DanceSequenceSets. Rounds are 0-based
// (the client looks a round up by MinRound..MaxRound).
export interface SequenceSet {
  SequenceDisplayTimeInSeconds: number;
  TurnTimeInSeconds: number;
  MinRound: number;
  MaxRound: number;
  DanceMoveIds: number[];
  FillerDanceMoveIds: number[];
  SequenceLength: number;
  TurnOutcomeSequenceDelayInSeconds: number;
}

const TIE_EPSILON = 0.001;

export function sequenceSetFor(sets: SequenceSet[], round: number): SequenceSet {
  const set = sets.find((s) => round >= s.MinRound && round <= s.MaxRound);
  if (!set) throw new Error(`no dance sequence set for round ${round}`);
  return set;
}

export function scorePlayer(moves: number[], expected: number[]): number {
  if (expected.length === 0) return 0;
  let correct = 0;
  for (let i = 0; i < Math.min(moves.length, expected.length); i++) if (moves[i] === expected[i]) correct++;
  return correct / expected.length;
}

export function teamRoundScore(playerScores: number[]): number {
  return playerScores.length === 0 ? 0 : playerScores.reduce((a, b) => a + b, 0) / playerScores.length;
}

// The player's dance animations (emote ids), one per expected move: a right
// move plays the round's dance for it (`emotes[move - 1]`, from the set's
// DanceMoveIds; the move itself if no emotes are given), a wrong or missing
// one plays the failure move. The client only ever shows moves 1-3 and never
// reads the set's emote ids, so this mapping is the server's.
export function outcomeFor(moves: number[], expected: number[], failureMoveId: number, emotes?: number[]): number[] {
  return expected.map((e, i) => (moves[i] === e ? (emotes?.[e - 1] ?? e) : failureMoveId));
}

// Final placement per team index ([team 0, team 1]). A tie puts both teams
// first; if nobody scored at all (an AFK match) nobody is paid.
export function decide(team0Total: number, team1Total: number): { placements: [number, number]; paid: boolean } {
  const paid = Math.max(team0Total, team1Total) >= TIE_EPSILON;
  if (Math.abs(team0Total - team1Total) < TIE_EPSILON) return { placements: [0, 0], paid };
  return { placements: team0Total > team1Total ? [0, 1] : [1, 0], paid };
}

export function pickMoves(count: number, pool: number[], rng: () => number = Math.random): number[] {
  return Array.from({ length: count }, () => pool[Math.min(pool.length - 1, Math.floor(rng() * pool.length))]!);
}
