// Tube races (party game templates 4 red and 5 blue, Mt Blizzard): up to 20
// racers from a scheduled lobby, timed and checked by the server.
//
// pgame.message types (PartyGameSessionMessageTypes):
//   10 SetTubeRaceModifierLayout  server  {"ModifierLayoutId":n}  which modifiers the client shows
//   11 CollectTubeRaceScoreModifier client {"ModifierId":n}
//   12 PlayerFinishedTubeRace     client {}
//   13 TubeRacePlayerResult       server {PlayerId, CompletionTimeInMilliseconds, ScoreModifier, OverallScore}
// A racer's own result opens their end popup ("calculating" until pgame.end);
// other results add rows. Time comes from the server clock; a finish too fast,
// too slow, away from RaceEndPosition or along a path that teleports (a jump
// or a burst of speed, see tube-race-rules.ts; the path starts at the lobby)
// scores DefaultPoints, and a claimed
// modifier counts only if the racer's reported path went past it. Racers who
// haven't finished by MaximumCompletionTimeInSeconds (plus slack) get a
// DefaultPoints result so their popup opens. Invalid and unfinished racers are
// placed but not paid.
//
// Locomotion as the client's own offline server sets it: Racing while racing,
// Default after the end.
import { getByRoom } from "../session-registry.ts";
import type { RegisteredSession } from "../session-registry.ts";
import { tubeRaceLayouts, type PartyGameDef, type TubeRaceModifier } from "./definitions.ts";
import { host, PartyGameSession, TIME_SCALE, type PartyGamePlayer, type PartyGameSlot } from "./session.ts";
import { judgeFinish, modifierTotal, placeRacers, raceScore, type TubeRaceData, type Vec3 } from "./tube-race-rules.ts";

const SET_LAYOUT = 10;
const COLLECT_MODIFIER = 11;
const PLAYER_FINISHED = 12;
const PLAYER_RESULT = 13;
const LOCOMOTION_DEFAULT = 0;
const LOCOMOTION_RACING = 7;
// Past MaximumCompletionTimeInSeconds before unfinished racers are given up on.
const END_SLACK_SECONDS = 5;
const MAX_PATH_POINTS = 2000;
// Lets the client show the end popup before its locomotion is reset.
const CLEANUP_DELAY_SECONDS = 2;

interface Result {
  elapsedMs: number;
  score: number;
  valid: boolean;
}

interface Racer {
  path: Vec3[];
  // Race-clock ms of each path point.
  times: number[];
  overflow: boolean;
  claims: number[];
  result?: Result;
}

export class TubeRace extends PartyGameSession {
  private readonly data: TubeRaceData;
  private layout: TubeRaceModifier[] = [];
  private startMs = 0;
  private endScheduled = false;
  private readonly racers = new Map<PartyGamePlayer, Racer>();

  constructor(id: number, def: PartyGameDef, players: RegisteredSession[], slots?: PartyGameSlot[]) {
    super(id, def, players, slots);
    this.data = def.gameData as unknown as TubeRaceData;
  }

  onStart(): void {
    // Every racer starts at the lobby: a position sent before the start (say,
    // already at the finish) is a jump away from it.
    const l = (this.def.lobbyData as { LobbyLocation?: { x: number; y: number; z: number } }).LobbyLocation;
    const lobby: Vec3 | undefined = l ? [l.x, l.y, l.z] : undefined;
    for (const p of this.players) {
      const pos = p.entry.session.lastPosition;
      const path = [lobby, pos?.length === 3 ? (pos.slice() as Vec3) : undefined].filter((v): v is Vec3 => !!v);
      this.racers.set(p, { path, times: path.map(() => 0), overflow: false, claims: [] });
      host.setLocomotion(p.entry, LOCOMOTION_RACING);
    }
    const layouts = [...tubeRaceLayouts(this.def.id)];
    const [layoutId, mods] = layouts[Math.floor(Math.random() * layouts.length)] ?? [0, []];
    this.layout = mods;
    this.sendMessage(SET_LAYOUT, `{"ModifierLayoutId":${layoutId}}`);
    this.startMs = Date.now();
    this.timer(this.data.MaximumCompletionTimeInSeconds + END_SLACK_SECONDS, () => this.timeUp());
  }

  onPlayerMoved(player: PartyGamePlayer, position: Vec3): void {
    const racer = this.racers.get(player);
    if (!racer || racer.result) return;
    // A client never sends this many in a race; past the cap the path can't be checked.
    if (racer.path.length >= MAX_PATH_POINTS) { racer.overflow = true; return; }
    racer.path.push([position[0], position[1], position[2]]);
    racer.times.push(this.clockMs());
  }

  // Race time in game ms (scaled back from PARTY_GAME_TIME_SCALE).
  private clockMs(): number {
    return Math.round((Date.now() - this.startMs) / TIME_SCALE);
  }

  onMessage(player: PartyGamePlayer, type: number, message: unknown): void {
    const racer = this.racers.get(player);
    if (!racer || racer.result) return;
    if (type === COLLECT_MODIFIER) {
      const id = message !== null && typeof message === "object" ? (message as { ModifierId?: unknown }).ModifierId : undefined;
      if (typeof id === "number" && Number.isInteger(id) && this.layout.some((m) => m.id === id) && !racer.claims.includes(id)) racer.claims.push(id);
    } else if (type === PLAYER_FINISHED) {
      const elapsedMs = this.clockMs();
      const j = judgeFinish(elapsedMs, racer.path, racer.times, racer.overflow, this.data);
      const modifier = j.valid ? modifierTotal(racer.claims, this.layout, racer.path) : 0;
      const score = j.valid ? raceScore(elapsedMs, modifier, this.data) : this.data.DefaultPoints;
      console.log(`[TUBE] race ${this.id} template ${this.def.id} ${player.entry.session.accountName} finished elapsed=${elapsedMs}ms valid=${j.valid} reason=${j.reason} score=${score} modifier=${modifier} claims=${racer.claims.length} points=${racer.path.length} maxJump=${j.maxJump.toFixed(1)}m maxSpeed=${j.maxSpeed.toFixed(1)}m/s`);
      this.publish(player, { elapsedMs, valid: j.valid, score }, modifier);
      this.endIfAllFinished();
    }
  }

  // Session ids can exceed 2^53, so PlayerId is spliced in as raw text.
  private publish(player: PartyGamePlayer, result: Result, modifier: number): void {
    this.racers.get(player)!.result = result;
    this.sendMessage(PLAYER_RESULT,
      `{"PlayerId":${player.entry.session.playerSessionId},"CompletionTimeInMilliseconds":${result.elapsedMs},"ScoreModifier":${modifier},"OverallScore":${result.score}}`);
  }

  private here(): PartyGamePlayer[] {
    return this.players.filter((p) => !p.left);
  }

  private endIfAllFinished(): void {
    if (this.here().every((p) => this.racers.get(p)?.result)) this.scheduleEnd();
  }

  private timeUp(): void {
    const capMs = this.data.MaximumCompletionTimeInSeconds * 1000;
    for (const p of this.here()) {
      if (this.racers.get(p)?.result) continue;
      console.log(`[TUBE] race ${this.id} template ${this.def.id} ${p.entry.session.accountName} did not finish (time cap) score=${this.data.DefaultPoints}`);
      this.publish(p, { elapsedMs: capMs, score: this.data.DefaultPoints, valid: false }, 0);
    }
    this.scheduleEnd();
  }

  private scheduleEnd(): void {
    if (this.endScheduled) return;
    this.endScheduled = true;
    this.timer(this.data.ShowRewardsDelayInSeconds, () => this.finish());
  }

  private finish(): void {
    const rows = this.here().flatMap((p) => {
      const r = this.racers.get(p)?.result;
      return r ? [{ key: p.entry, score: r.score, elapsedMs: r.elapsedMs, valid: r.valid }] : [];
    });
    const unpaid = new Set(this.here().filter((p) => !this.racers.get(p)?.result?.valid).map((p) => p.entry));
    this.endWith(placeRacers(rows, this.data.SinglePlayerPlacement), unpaid);
  }

  onPlayerLeft(_player: PartyGamePlayer): void {
    if (this.here().length === 0) this.endWith(new Map());
    else this.endIfAllFinished();
  }

  // No game prop, so no quitting by putting one away.
  onPlayerQuit(_player: PartyGamePlayer): void {}

  onEnded(): void {
    const racers = this.here();
    setTimeout(() => {
      const room = new Set(getByRoom(racers[0]?.entry.session.roomName ?? ""));
      for (const p of racers) if (room.has(p.entry)) host.setLocomotion(p.entry, LOCOMOTION_DEFAULT);
    }, CLEANUP_DELAY_SECONDS * 1000 * TIME_SCALE);
  }
}
