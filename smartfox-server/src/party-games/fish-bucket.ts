// Fish Bucket / "Ink or Swim" (template 1): 2 to 4 players take turns drawing
// from a server-owned deck. A fish card adds to the bucket and lets the
// player draw again or pass; a squid card (negative) takes fish away and ends
// the turn. The most fish when the deck runs out wins. Client FishBucket
// session:
//   in:  SetGameState {GameStateId 1 Intro / 2 Game / 3 Finished}
//        (0 AwaitingPositions is entered by the client itself on pgame.start.v2)
//        SetGameStartPositions (4), ShowTurnOutput (5) {PlayerId, ScoreDelta},
//        PlayerTurnStart (6) {PlayerId}, PlayerLeftGame (7) {PlayerId}
//   out: SetGameStartPositions {OwnerPosition, PlayerPositions[players-1],
//        GamePositions[>=1]} from the owner (players[0]) only.
// The client never sends a draw as a pgame.message: the buttons are locomotion
// actions. The button prefabs store InputEvents.Actions numbers in the retail
// enum (Jump 0, Interact 1, Snowball 2, Action1 3, Action2 4): Fish and the
// owner's lobby Start are 3 = Action1 (l.a 7), Pass is 4 = Action2 (l.a 8);
// FishBucket.onDoActionEvent disables the controls on exactly Action1/Action2.
// OpenCPI inserted Sprint into that enum, so a client without the prefab fix
// sends nothing for Fish/Start and l.a 7 for Pass, which this server reads as a
// draw (Fish), not a hand-over. Every other non-Move byte and
// every unhandled pgame.message is logged (`[FISH] ...`). An idle turn is still
// dealt a card on timeout, so a game of AFK players runs to the end of the deck.
import type { RegisteredSession } from "../session-registry.ts";
import { PartyGameSession, type PartyGamePlayer } from "./session.ts";
import type { PartyGameDef } from "./definitions.ts";
import { applyDelta, buildDeck, placementsFromScores } from "./fish-bucket-rules.ts";

const SET_GAME_STATE = 1, SET_GAME_START_POSITIONS = 4, SHOW_TURN_OUTPUT = 5, PLAYER_TURN_START = 6, PLAYER_LEFT_GAME = 7;
const STATE_INTRO = 1, STATE_GAME = 2, STATE_FINISHED = 3;
// The owner's lobby Start press (Action1), what the invitation code listens for.
export const ACTION_START = 7;
export const FISH_ACTIONS = [7];
export const PASS_ACTIONS = [8];
// Bytes sent continuously or by ordinary play: Move 0, Jump 1, Interact 2, and 12.
const QUIET_ACTIONS = new Set([0, 1, 2, 12]);
const POSITIONS_BACKSTOP_SECONDS = 10;
const TURN_GRACE_SECONDS = 2;
const OUTRO_SECONDS = 1;
const MAX_GAME_POSITIONS = 4;
// Generous: the template's MaxGameStartDistance is 5 m.
const MAX_POSITION_DISTANCE = 30;

type Phase = "positions" | "intro" | "turn" | "delay" | "over";
type Vec = { x: number; y: number; z: number };

function vec(v: unknown): Vec | undefined {
  const o = v as Record<string, unknown> | null;
  if (!o || typeof o !== "object") return undefined;
  const { x, y, z } = o;
  return [x, y, z].every((c) => typeof c === "number" && Number.isFinite(c)) ? { x: x as number, y: y as number, z: z as number } : undefined;
}

function vecs(list: unknown, min: number, max: number): Vec[] | undefined {
  if (!Array.isArray(list) || list.length < min || list.length > max) return undefined;
  const out = list.map(vec);
  return out.every((p) => p !== undefined) ? (out as Vec[]) : undefined;
}

export class FishBucket extends PartyGameSession {
  // Tests replace this with a fixed deck.
  static makeDeck: (def: PartyGameDef, playerCount: number) => number[] = (def, count) => buildDeck(def.gameData, count);

  private deck: number[] = [];
  private deckPos = 0;
  private phase: Phase = "positions";
  private cur = 0;
  // Whether the current player has drawn a fish card this turn (so may pass).
  private drew = false;
  // Counts timer arming, so a timer only fires for the step that armed it.
  private step = 0;
  private readonly scores: number[];
  private readonly quit = new Set<PartyGamePlayer>();
  // Set once the deck is spent (during the outro).
  private decided: Map<RegisteredSession, number> | undefined;
  // Who was already unpaid when the standings were decided (quit during play); an outro quitter finished, so is paid.
  private decidedUnpaid = new Set<RegisteredSession>();

  constructor(id: number, def: PartyGameDef, players: RegisteredSession[]) {
    super(id, def, players);
    this.scores = players.map(() => 0);
  }

  private seconds(key: string, fallback: number): number {
    const v = Number(this.def.gameData[key]);
    return Number.isFinite(v) ? v : fallback;
  }

  private log(msg: string): void {
    console.log(`[FISH] game ${this.id} ${msg}`);
  }

  private sid(index: number): string {
    return this.players[index]!.entry.session.playerSessionId!;
  }

  private active(p: PartyGamePlayer): boolean {
    return !p.left && !this.quit.has(p);
  }

  onStart(): void {
    this.deck = FishBucket.makeDeck(this.def, this.players.length);
    this.timer(POSITIONS_BACKSTOP_SECONDS, () => {
      if (this.phase === "positions") this.endWith(new Map());
    });
  }

  onMessage(player: PartyGamePlayer, type: number, message: unknown): void {
    // The retail client sends only the start positions; anything else is logged to learn what it does send.
    if (type !== SET_GAME_START_POSITIONS) {
      this.log(`message type=${type} from ${player.entry.session.userName} phase=${this.phase}`);
      return;
    }
    if (this.phase !== "positions" || player !== this.players[0]) return;
    const m = message as Record<string, unknown> | null;
    const owner = vec(m?.OwnerPosition);
    const others = vecs(m?.PlayerPositions, this.players.length - 1, this.players.length - 1);
    const game = vecs(m?.GamePositions, 1, MAX_GAME_POSITIONS);
    if (!owner || !others || !game) return;
    // The owner's client spawns everyone within a few metres of the owner; a far-off point only drags players away.
    const at = player.entry.session.lastPosition;
    if (at?.length === 3 && [owner, ...others, ...game].some((p) => Math.hypot(p.x - at[0]!, p.y - at[1]!, p.z - at[2]!) > MAX_POSITION_DISTANCE)) {
      this.log(`start positions too far from the owner, ignored`);
      return;
    }
    this.phase = "intro";
    // Rebuilt from the validated numbers; the client's own JSON is never echoed.
    this.sendMessage(SET_GAME_START_POSITIONS, { OwnerPosition: owner, PlayerPositions: others, GamePositions: game, IntData: [this.deck.length] });
    this.sendMessage(SET_GAME_STATE, { GameStateId: STATE_INTRO });
    this.timer(this.seconds("IntroTimeInSeconds", 5), () => {
      this.sendMessage(SET_GAME_STATE, { GameStateId: STATE_GAME });
      this.startTurn();
    });
  }

  private startTurn(): void {
    // The next active player at or after cur.
    for (let i = 0; i < this.players.length && !this.active(this.players[this.cur]!); i++) this.cur = (this.cur + 1) % this.players.length;
    this.drew = false;
    this.phase = "turn";
    this.sendMessage(PLAYER_TURN_START, `{"PlayerId":${this.sid(this.cur)}}`);
    this.armTimeout();
  }

  // A player who does nothing is dealt a card (as the old server did), so a game of
  // AFK players, or buttons the server can't see, still runs to the end of the deck;
  // after a fish card the turn just passes.
  private armTimeout(): void {
    const mine = ++this.step;
    this.timer(this.seconds("TurnTimeInSeconds", 10) + TURN_GRACE_SECONDS, () => {
      if (this.step !== mine || this.phase !== "turn") return;
      if (this.drew) this.nextTurn();
      else {
        this.log(`turn timed out, dealing a card to ${this.players[this.cur]!.entry.session.userName}`);
        this.draw();
      }
    });
  }

  private nextTurn(): void {
    this.step++;
    this.cur = (this.cur + 1) % this.players.length;
    this.startTurn();
  }

  onAction(player: PartyGamePlayer, action: number, _position: [number, number, number]): void {
    if (!QUIET_ACTIONS.has(action)) this.log(`action byte=${action} player=${player.entry.session.userName} phase=${this.phase}`);
    if (this.phase !== "turn" || player !== this.players[this.cur]) return;
    if (FISH_ACTIONS.includes(action)) this.draw();
    else if (PASS_ACTIONS.includes(action) && this.drew) this.nextTurn();
  }

  private draw(): void {
    this.phase = "delay";
    this.step++;
    const card = this.deck[this.deckPos++]!;
    this.scores[this.cur] = applyDelta(this.scores[this.cur]!, card);
    this.sendMessage(SHOW_TURN_OUTPUT, `{"PlayerId":${this.sid(this.cur)},"ScoreDelta":${card}}`);
    const fish = card > 0;
    const delay = fish ? this.seconds("NextTurnDelayFishInSeconds", 3) : this.seconds("NextTurnDelaySquidInSeconds", 5);
    this.timer(delay, () => {
      if (this.deckPos >= this.deck.length) this.finish();
      else if (!fish || !this.active(this.players[this.cur]!)) this.nextTurn();
      else {
        this.phase = "turn";
        this.drew = true;
        this.armTimeout();
      }
    });
  }

  // Placements for the players still in, plus the quitters (listed, unpaid).
  private standings(): { placements: Map<RegisteredSession, number>; unpaid: Set<RegisteredSession> } {
    const placements = new Map<RegisteredSession, number>();
    const unpaid = new Set<RegisteredSession>();
    const stay = this.players.map((p, i) => ({ p, i })).filter(({ p }) => this.active(p));
    const ranks = placementsFromScores(stay.map(({ i }) => this.scores[i]!));
    stay.forEach(({ p }, k) => placements.set(p.entry, ranks[k]!));
    const worst = Math.max(-1, ...ranks) + 1;
    for (const p of this.players) {
      if (!p.left && this.quit.has(p)) {
        placements.set(p.entry, worst);
        unpaid.add(p.entry);
      }
    }
    return { placements, unpaid };
  }

  private finish(): void {
    this.phase = "over";
    const { placements, unpaid } = this.standings();
    this.decided = placements;
    this.decidedUnpaid = unpaid;
    this.sendMessage(SET_GAME_STATE, { GameStateId: STATE_FINISHED });
    this.timer(OUTRO_SECONDS, () => this.endWith(placements, unpaid));
  }

  // A player quit (kept in the room, waiting for pgame.end) or disconnected.
  private leave(player: PartyGamePlayer): void {
    if (this.decided) {
      this.endWith(new Map([...this.decided].filter(([entry]) => !this.players.find((p) => p.entry === entry)?.left)), new Set([...this.decidedUnpaid].filter((entry) => !this.players.find((p) => p.entry === entry)?.left)));
      return;
    }
    this.sendMessage(PLAYER_LEFT_GAME, `{"PlayerId":${this.sid(this.players.indexOf(player))}}`);
    const stay = this.players.filter((p) => this.active(p));
    if (stay.length <= 1) {
      const { placements, unpaid } = this.standings();
      for (const p of stay) placements.set(p.entry, 0);
      this.endWith(placements, unpaid);
      return;
    }
    if (this.phase === "turn" && this.players[this.cur] === player) this.nextTurn();
    // The client restores a quitter's controls only in destroy(), which runs on pgame.end. Its
    // destroy() throws before the cannon exists (positions, intro), so those wait for the real end.
    if (this.phase === "turn" || this.phase === "delay") this.release(player);
  }

  onPlayerQuit(player: PartyGamePlayer): void {
    this.quit.add(player);
    this.leave(player);
  }

  onPlayerLeft(player: PartyGamePlayer): void {
    this.leave(player);
  }
}
