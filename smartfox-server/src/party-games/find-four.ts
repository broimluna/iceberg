// Find Four (template 2). The server owns the board; clients only pick a
// column. Client FindFour session:
//   in:  ShowTurnOutput {PlayerId, ScoreDelta = column}
//   out: SetGameState {GameStateId 0 Intro / 1 Game / 2 Finished},
//        PlayerTurnStart {PlayerId}, ShowTurnOutput {PlayerId, ScoreDelta}
// players[0] is red and moves first. PlayerTurnStart is ignored outside the
// Game state, and a client that sent a move waits (controls off) for the
// ShowTurnOutput echo, so every accepted move is echoed.
import type { RegisteredSession } from "../session-registry.ts";
import { PartyGameSession, type PartyGamePlayer } from "./session.ts";

const SET_GAME_STATE = 1;
const SHOW_TURN_OUTPUT = 5;
const PLAYER_TURN_START = 6;
const STATE_INTRO = 0, STATE_GAME = 1, STATE_FINISHED = 2;
// The client auto-sends at TurnTimeInSeconds - 1; this covers a client
// that never does.
const BACKSTOP_GRACE_SECONDS = 2;

// Column to play: non-numbers become the default, floats are floored,
// out-of-range clamps, a full column moves to the nearest open one (lower
// index on a tie). -1 when the board is full.
export function normaliseColumn(board: number[][], wanted: unknown, defaultColumn: number, height = 6): number {
  const width = board.length;
  let col = typeof wanted === "number" && Number.isFinite(wanted) ? Math.floor(wanted) : defaultColumn;
  col = Math.min(width - 1, Math.max(0, col));
  for (let d = 0; d < width; d++) {
    for (const c of [col - d, col + d]) if (c >= 0 && c < width && board[c]!.length < height) return c;
  }
  return -1;
}

export class FindFour extends PartyGameSession {
  private readonly width = Number(this.def.gameData.GameBoardWidth ?? 7);
  private readonly height = Number(this.def.gameData.GameBoardHeight ?? 6);
  private readonly toWin = Number(this.def.gameData.SequenceCountToWin ?? 4);
  private readonly defaultColumn = Number(this.def.gameData.DefaultColumn ?? 3);
  private readonly board: number[][] = Array.from({ length: this.width }, () => [] as number[]);
  private turn = 0;
  private waitingFor = -1;
  // Counts turns, so a backstop only fires for the turn that armed it.
  private turnSeq = 0;
  // Set once a win or draw is decided (during the outro).
  private decided: Map<RegisteredSession, number> | undefined;

  private seconds(key: string, fallback: number): number {
    const v = Number(this.def.gameData[key]);
    return Number.isFinite(v) ? v : fallback;
  }

  private sid(index: number): string {
    return this.players[index]!.entry.session.playerSessionId!;
  }

  onStart(): void {
    this.sendMessage(SET_GAME_STATE, { GameStateId: STATE_INTRO });
    this.timer(this.seconds("IntroTimeInSeconds", 5), () => {
      this.sendMessage(SET_GAME_STATE, { GameStateId: STATE_GAME });
      this.startTurn();
    });
  }

  private startTurn(): void {
    this.waitingFor = this.turn;
    const mover = this.turn;
    const seq = ++this.turnSeq;
    this.sendMessage(PLAYER_TURN_START, `{"PlayerId":${this.sid(mover)}}`);
    this.timer(this.seconds("TurnTimeInSeconds", 20) + BACKSTOP_GRACE_SECONDS, () => {
      if (this.turnSeq === seq && this.waitingFor === mover) this.place(mover, this.defaultColumn);
    });
  }

  onMessage(player: PartyGamePlayer, type: number, message: unknown): void {
    if (type !== SHOW_TURN_OUTPUT) return;
    const index = this.players.indexOf(player);
    if (index !== this.waitingFor) return;
    this.place(index, (message as { ScoreDelta?: unknown } | null)?.ScoreDelta);
  }

  private place(index: number, wanted: unknown): void {
    const col = normaliseColumn(this.board, wanted, this.defaultColumn, this.height);
    if (col < 0) return;
    this.waitingFor = -1;
    this.board[col]!.push(index);
    this.sendMessage(SHOW_TURN_OUTPUT, `{"PlayerId":${this.sid(index)},"ScoreDelta":${col}}`);
    this.timer(this.seconds("ChipPlaceTimeInSeconds", 2), () => {
      const other = this.players[1 - index]!.entry;
      const me = this.players[index]!.entry;
      if (this.isWin(col)) this.finish(new Map([[me, 0], [other, 1]]));
      else if (this.board.every((c) => c.length >= this.height)) this.finish(new Map([[this.players[0]!.entry, 1], [this.players[1]!.entry, 1]]));
      else {
        this.turn = 1 - index;
        this.startTurn();
      }
    });
  }

  private isWin(col: number): boolean {
    const row = this.board[col]!.length - 1;
    const who = this.board[col]![row];
    const at = (x: number, y: number) => (x >= 0 && x < this.width && y >= 0 ? this.board[x]![y] : undefined);
    for (const [dx, dy] of [[1, 0], [0, 1], [1, 1], [1, -1]] as const) {
      let count = 1;
      for (const s of [1, -1]) {
        let x = col + dx * s, y = row + dy * s;
        while (at(x, y) === who) { count++; x += dx * s; y += dy * s; }
      }
      if (count >= this.toWin) return true;
    }
    return false;
  }

  private finish(placements: Map<RegisteredSession, number>): void {
    this.decided = placements;
    this.sendMessage(SET_GAME_STATE, { GameStateId: STATE_FINISHED });
    this.timer(this.seconds("OutroTimeInSeconds", 4), () => this.endWith(placements));
  }

  onPlayerQuit(player: PartyGamePlayer): void {
    if (this.decided) {
      this.endWith(this.decided);
      return;
    }
    const stayer = this.players.find((p) => p !== player && !p.left);
    const placements = new Map<RegisteredSession, number>();
    if (stayer) placements.set(stayer.entry, 0);
    // The quitter is still here, and the owner's end screen looks up its own placement.
    placements.set(player.entry, 1);
    this.endWith(placements, new Set([player.entry]));
  }

  // Results list only players still here (the end popup looks up every
  // listed player). Before a result is decided, the player who stays wins;
  // after, the decided result stands.
  onPlayerLeft(player: PartyGamePlayer): void {
    if (this.decided) {
      this.endWith(new Map([...this.decided].filter(([entry]) => entry !== player.entry)));
      return;
    }
    const stayer = this.players.find((p) => p !== player && !p.left);
    this.endWith(stayer ? new Map([[stayer.entry, 0]]) : new Map());
  }
}
