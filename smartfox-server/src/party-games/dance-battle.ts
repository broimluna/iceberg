// Dance Battle (party game template 3): two teams, 4 rounds, up to 20 players.
//
// The game state lives on a room-wide MMO item (the client's DanceBattleMmoItem,
// so spectators see the stage too); only players get pgame.*. Per round:
//   turn       {Moves, StartTime, RoundNum}  the sequence to repeat (display, then input)
//   dancemoves {PlayerMoveDatas, StartTimeInSeconds}  every player's dance, as emote ids
//   score      {Team1Score, Team2Score, StartTimeInSeconds}  running team totals
// The client applies each variable only when its timestamp changes, and drops
// dancemoves stamped more than 5 s from its clock, so every write is stamped
// fresh. Team 1 in the client is TeamId 0 (blue), "Team2" is TeamId 1 (red).
//
// Client facts this relies on (ReMix-Game, checked against the decompiled
// client): the player sees and sends only moves 1, 2 and 3 (three icons, three
// buttons) via pgame.message ShowTurnOutput {PlayerId, ScoreDelta}; it never
// reads the data's DanceMoveIds/SuccessMoveId/FailureMoveId, so the emote a
// move plays is the server's choice (see dance-rules.ts outcomeFor). Round
// numbers are 0-based (the client finds a round's set by Min/MaxRound).
//
// Order, as the original extension found it works: pgame.start.v2 first, then
// the game prop and the locked pose, the item a moment later, and nothing
// cleared until the client has shown the end popup.
import { getByRoom } from "../session-registry.ts";
import type { RegisteredSession } from "../session-registry.ts";
import { addRoomItem, setRoomItemVar, removeRoomItem, ITEM_CATEGORY_DANCE_BATTLE, type RoomItem } from "./room-items.ts";
import { host, PartyGameSession, TIME_SCALE, type PartyGamePlayer, type PartyGameSlot } from "./session.ts";
import type { PartyGameDef } from "./definitions.ts";
import { decide, outcomeFor, pickMoves, scorePlayer, sequenceSetFor, teamRoundScore, type SequenceSet } from "./dance-rules.ts";

// gameData.GameProp is prop id 91.
const GAME_PROP = "DanceBattleGameServerAdded";
// Domain.LocomotionState GenericState1: locked, dancing idle.
const LOCOMOTION_PARTY_GAME = 2;
const LOCOMOTION_DEFAULT = 0;
const SHOW_TURN_OUTPUT = 5; // PartyGameSessionMessageTypes
const MOVES = [1, 2, 3];
// Lets the client finish setting up its session before the item shows up.
const ITEM_DELAY_SECONDS = 0.1;
// Lets the client show the end popup and restore its controls before the
// prop, pose and item are taken away.
const CLEANUP_DELAY_SECONDS = 2;

interface DanceData {
  NumberOfRounds: number;
  IntroTimeInSeconds: number;
  OutroTimeInSeconds: number;
  TurnStartDelayInSeconds: number;
  TurnOutcomeStartDelayInSeconds: number;
  FailureMoveId: number;
  GameLocation: { x: number; y: number; z: number };
  DanceSequenceSets: SequenceSet[];
}

type Phase = "intro" | "display" | "input" | "perform" | "results" | "outro" | "ended";

export class DanceBattle extends PartyGameSession {
  phase: Phase = "intro";
  private readonly data: DanceData;
  private item?: RoomItem;
  private round = 0;
  private set!: SequenceSet;
  private expected: number[] = [];
  private readonly moves = new Map<PartyGamePlayer, number[]>();
  private readonly totals: [number, number] = [0, 0];
  private readonly quit = new Set<PartyGamePlayer>();
  private readonly stamps = new Map<string, number>();

  constructor(id: number, def: PartyGameDef, players: RegisteredSession[], slots?: PartyGameSlot[]) {
    super(id, def, players, slots);
    this.data = def.gameData as unknown as DanceData;
  }

  // Strictly increasing per variable, so a repeat within a second still
  // reads as new to the client.
  private stamp(name: string): number {
    const t = Math.max(Math.floor(Date.now() / 1000), (this.stamps.get(name) ?? 0) + 1);
    this.stamps.set(name, t);
    return t;
  }

  private setVar(name: string, json: string): void {
    if (this.item) setRoomItemVar(this.item, name, { type: "string", value: json });
  }

  onStart(): void {
    for (const p of this.players) {
      host.setProp(p.entry, GAME_PROP);
      host.setLocomotion(p.entry, LOCOMOTION_PARTY_GAME);
    }
    this.timer(ITEM_DELAY_SECONDS, () => {
      const loc = this.data.GameLocation;
      this.item = addRoomItem(this.players[0]!.entry.session.roomName, [loc.x, loc.y, loc.z], {
        category: { type: "int", value: ITEM_CATEGORY_DANCE_BATTLE },
        creator: { type: "int", value: 0 },
        int_a: { type: "int", value: this.def.id },
        statetimestamp: { type: "string", value: String(Math.floor(Date.now() / 1000)) },
        score: { type: "string", value: "{}" },
        turn: { type: "string", value: "{}" },
        dancemoves: { type: "string", value: "{}" },
      });
      this.timer(this.data.IntroTimeInSeconds, () => this.startRound());
    });
  }

  private startRound(): void {
    this.phase = "display";
    this.set = sequenceSetFor(this.data.DanceSequenceSets, this.round);
    this.expected = pickMoves(this.set.SequenceLength, MOVES);
    this.moves.clear();
    this.setVar("turn", JSON.stringify({ Moves: this.expected, StartTime: this.stamp("turn"), RoundNum: this.round }));
    this.timer(this.set.SequenceDisplayTimeInSeconds, () => {
      this.phase = "input";
      // The client's turn timer runs TurnTimeInSeconds; its last taps may still be in flight.
      this.timer(this.set.TurnTimeInSeconds + this.data.TurnOutcomeStartDelayInSeconds, () => this.performMoves());
    });
  }

  // Session ids can exceed 2^53, so they're spliced in as raw text.
  private performMoves(): void {
    this.phase = "perform";
    const dancers = this.players.filter((p) => !p.left);
    const datas = dancers.map((p) => {
      const ids = outcomeFor(this.moves.get(p) ?? [], this.expected, this.data.FailureMoveId, this.set.DanceMoveIds);
      return `{"PlayerSessionId":${p.entry.session.playerSessionId},"DanceMoveIds":[${ids.join(",")}]}`;
    });
    this.setVar("dancemoves", `{"PlayerMoveDatas":[${datas.join(",")}],"StartTimeInSeconds":${this.stamp("dancemoves")}}`);
    this.timer(this.set.TurnOutcomeSequenceDelayInSeconds, () => this.scoreRound());
  }

  private active(teamId: number): PartyGamePlayer[] {
    return this.players.filter((p) => p.teamId === teamId && !p.left && !this.quit.has(p));
  }

  private scoreRound(): void {
    this.phase = "results";
    for (const team of [0, 1] as const) {
      this.totals[team] += teamRoundScore(this.active(team).map((p) => scorePlayer(this.moves.get(p) ?? [], this.expected)));
    }
    this.setVar("score", JSON.stringify({ Team1Score: this.totals[0], Team2Score: this.totals[1], StartTimeInSeconds: this.stamp("score") }));
    this.round++;
    if (this.round < this.data.NumberOfRounds) {
      this.timer(this.data.TurnStartDelayInSeconds, () => this.startRound());
    } else {
      this.phase = "outro";
      this.timer(this.data.OutroTimeInSeconds, () => this.finish());
    }
  }

  private finish(): void {
    const verdict = decide(this.totals[0], this.totals[1]);
    const placements = new Map<RegisteredSession, number>();
    const unpaid = new Set<RegisteredSession>();
    for (const p of this.players) {
      if (p.left) continue;
      placements.set(p.entry, verdict.placements[p.teamId === 0 ? 0 : 1]);
      if (!verdict.paid || this.quit.has(p)) unpaid.add(p.entry);
    }
    this.endWith(placements, unpaid);
  }

  onMessage(player: PartyGamePlayer, type: number, message: unknown): void {
    if (type !== SHOW_TURN_OUTPUT || this.phase !== "input" || this.quit.has(player)) return;
    const move = (message as { ScoreDelta?: unknown } | null)?.ScoreDelta;
    if (typeof move !== "number" || !MOVES.includes(move)) return;
    const mine = this.moves.get(player) ?? [];
    if (mine.length >= this.expected.length) return;
    this.moves.set(player, [...mine, move]);
  }

  // A team with nobody left playing loses; if both are gone there's no result.
  private checkTeams(): void {
    if (this.ended) return;
    const empty = ([0, 1] as const).filter((t) => this.active(t).length === 0);
    if (empty.length === 0) return;
    const placements = new Map<RegisteredSession, number>();
    const unpaid = new Set<RegisteredSession>();
    if (empty.length === 1) {
      for (const p of this.players) {
        if (p.left) continue;
        placements.set(p.entry, p.teamId === empty[0] ? 1 : 0);
        if (this.quit.has(p)) unpaid.add(p.entry);
      }
    }
    this.endWith(placements, unpaid);
  }

  onPlayerLeft(_player: PartyGamePlayer): void {
    this.checkTeams();
  }

  // Putting the game prop away: they stay for pgame.end but stop counting.
  onPlayerQuit(player: PartyGamePlayer): void {
    this.quit.add(player);
    this.checkTeams();
  }

  onEnded(): void {
    this.phase = "ended";
    const item = this.item;
    const dancers = this.players.filter((p) => !p.left);
    setTimeout(() => {
      if (item) removeRoomItem(item);
      const here = new Set(getByRoom(this.players[0]!.entry.session.roomName));
      for (const p of dancers) {
        if (!here.has(p.entry)) continue;
        if (p.entry.session.heldObject === GAME_PROP) host.setProp(p.entry, undefined);
        host.setLocomotion(p.entry, LOCOMOTION_DEFAULT);
      }
    }, CLEANUP_DELAY_SECONDS * 1000 * TIME_SCALE);
  }
}
