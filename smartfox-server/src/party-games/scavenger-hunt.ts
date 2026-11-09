// Scavenger Hunt (template 0): two players from an invitation, one hides
// marbles and the other finds them. The server picks the roles, accepts the
// drops and pickups it can verify, and decides the winner.
//
// pgame.message types (PartyGameSessionMessageTypes):
//   0 SetRole      server, to each player  {"RoleId":0 Hider | 1 Finder}
//   1 SetGameState server  {"GameStateId":0 AwaitingRoles | 1 Hiding | 2 Finding}
//   2 AddItem      server  {"ItemId":n,"Pos":{x,y,z}}
//   3 RemoveItem   client {"ItemId":n}, echoed to both when accepted
// The client never sends AddItem: the Hider's action button is
// LocomotionAction.Action1 (l.a action byte 7), and the marble goes where
// the Hider stands. The Hider's prop (marble bag, then clock) is held from
// the start; the Finder's (metal detector) is set just before Finding, a
// moment ahead of the state change because the client dispatches user
// variable changes once per frame.
import type { RegisteredSession } from "../session-registry.ts";
import { host, PartyGameSession, type PartyGamePlayer, type PartyGameSlot } from "./session.ts";
import type { PartyGameDef } from "./definitions.ts";
import { MAX_JUMP, MAX_SPEED, SPEED_SPAN_MS, type Vec3 } from "./tube-race-rules.ts";
import { decideWinner, parseItemId, validateDrop, validatePickup } from "./scavenger-hunt-rules.ts";

const SET_ROLE = 0, SET_GAME_STATE = 1, ADD_ITEM = 2, REMOVE_ITEM = 3;
const ROLE_HIDER = 0, ROLE_FINDER = 1;
const STATE_HIDING = 1, STATE_FINDING = 2;
// Between Hiding and Finding (the Finder's prop settling): the client sees no state change.
const STATE_SETTLING = 3;
const ACTION1 = 7;
const HIDER_PROP = "ScavengerHuntHiderServerAdded";
const FINDER_PROP = "ScavengerHuntFinderServerAdded";
const PROP_SETTLE_SECONDS = 1;
const FINISH_DELAY_SECONDS = 1;

export class ScavengerHunt extends PartyGameSession {
  // Index in `players` of the Hider; tests replace it.
  static pickHider: () => 0 | 1 = () => (Math.random() < 0.5 ? 0 : 1);

  private hider!: PartyGamePlayer;
  private finder!: PartyGamePlayer;
  // 0 = intro, then STATE_HIDING / STATE_FINDING.
  private state = 0;
  private nextItemId = 1;
  private readonly marbles = new Map<number, Vec3>();
  private hidden = 0;
  private found = 0;
  private readonly lastPos = new Map<PartyGamePlayer, Vec3>();
  // Players whose reported position jumped further than any legitimate move
  // (a client placing itself at a marble, or out of reach of one): they
  // can't drop or pick up.
  private readonly jumped = new Set<PartyGamePlayer>();
  // Recent samples (position + arrival ms) per player, for the sustained-speed check.
  private readonly samples = new Map<PartyGamePlayer, { p: Vec3; t: number }[]>();
  // Set once the Finder has found every marble (during the finish delay).
  private decided: Map<RegisteredSession, number> | undefined;

  constructor(id: number, def: PartyGameDef, players: RegisteredSession[], slots?: PartyGameSlot[]) {
    super(id, def, players, slots);
  }

  private seconds(key: string, fallback: number): number {
    const v = Number(this.def.gameData[key]);
    return Number.isFinite(v) ? v : fallback;
  }

  private log(msg: string): void {
    console.log(`[SCAVENGER] game ${this.id} ${msg}`);
  }

  override gamePropFor(player: PartyGamePlayer): string | null {
    if (player === this.hider) return HIDER_PROP;
    return player === this.finder ? FINDER_PROP : null;
  }

  onStart(): void {
    const h = ScavengerHunt.pickHider();
    this.hider = this.players[h]!;
    this.finder = this.players[1 - h]!;
    for (const p of this.players) {
      const at = p.entry.session.lastPosition;
      if (at?.length === 3) this.lastPos.set(p, [at[0]!, at[1]!, at[2]!]);
    }
    this.sendMessageTo(this.hider, SET_ROLE, { RoleId: ROLE_HIDER });
    this.sendMessageTo(this.finder, SET_ROLE, { RoleId: ROLE_FINDER });
    host.setProp(this.hider.entry, HIDER_PROP);
    this.log(`hider ${this.hider.entry.session.accountName}, finder ${this.finder.entry.session.accountName}`);
    this.timer(this.seconds("IntroTimeInSeconds", 5), () => {
      this.state = STATE_HIDING;
      this.sendMessage(SET_GAME_STATE, { GameStateId: STATE_HIDING });
      this.timer(this.seconds("HideTimeInSeconds", 25) + this.seconds("HideBufferTimeInSeconds", 3), () => this.startFinding());
    });
  }

  private startFinding(): void {
    this.state = STATE_SETTLING;
    host.setProp(this.finder.entry, FINDER_PROP);
    this.timer(PROP_SETTLE_SECONDS, () => {
      this.state = STATE_FINDING;
      this.sendMessage(SET_GAME_STATE, { GameStateId: STATE_FINDING });
      this.log(`finding, ${this.hidden} marbles hidden`);
      this.timer(this.seconds("FindTimeInSeconds", 55) + this.seconds("FindBufferTimeInSeconds", 3), () => this.finish());
    });
  }

  onPlayerMoved(player: PartyGamePlayer, position: Vec3): void {
    const before = this.lastPos.get(player);
    const now = Date.now();
    const hist = this.samples.get(player) ?? [];
    hist.push({ p: [position[0], position[1], position[2]], t: now });
    while (hist.length > 1 && now - hist[0]!.t > SPEED_SPAN_MS * 2) hist.shift();
    this.samples.set(player, hist);
    // Same rule as the tube race: spans shorter than SPEED_SPAN_MS count as that
    // long, so bunched packets don't read as speed.
    let along = 0, maxSpeed = 0;
    for (let i = hist.length - 2; i >= 0; i--) {
      const a = hist[i]!.p, b = hist[i + 1]!.p;
      along += Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
      maxSpeed = Math.max(maxSpeed, (along * 1000) / Math.max(now - hist[i]!.t, SPEED_SPAN_MS));
    }
    const jump = before ? Math.hypot(position[0] - before[0], position[1] - before[1], position[2] - before[2]) : 0;
    if ((jump > MAX_JUMP || maxSpeed > MAX_SPEED) && !this.jumped.has(player)) {
      this.jumped.add(player);
      this.log(`${player.entry.session.accountName} moved implausibly (${jump.toFixed(1)}m step, ${maxSpeed.toFixed(1)}m/s), disqualified from dropping/picking up`);
    }
    this.lastPos.set(player, [position[0], position[1], position[2]]);
  }

  // Runs before onPlayerMoved for the same packet, so lastPos is the
  // previous position.
  override onAction(player: PartyGamePlayer, action: number, position: Vec3): void {
    if (player !== this.hider || action !== ACTION1 || this.state !== STATE_HIDING) return;
    if (this.jumped.has(player)) {
      this.log("drop refused: jumped");
      return;
    }
    const max = this.seconds("MaxHiddenItems", 3);
    const verdict = validateDrop(position, this.lastPos.get(player), [...this.marbles.values()], max);
    if (verdict !== "ok") {
      this.log(`drop refused: ${verdict}`);
      return;
    }
    const id = this.nextItemId++;
    this.marbles.set(id, [position[0], position[1], position[2]]);
    this.hidden++;
    this.sendMessage(ADD_ITEM, `{"ItemId":${id},"Pos":{"x":${position[0]},"y":${position[1]},"z":${position[2]}}}`);
  }

  onMessage(player: PartyGamePlayer, type: number, message: unknown): void {
    if (type !== REMOVE_ITEM || player !== this.finder || this.state !== STATE_FINDING || this.decided) return;
    if (this.jumped.has(player)) return;
    const id = parseItemId(message);
    const at = id === undefined ? undefined : this.marbles.get(id);
    if (id === undefined || !at) return;
    const here = this.lastPos.get(player);
    const verdict = validatePickup(here, at);
    this.log(`pickup of item ${id}: ${verdict} dist=${here ? Math.hypot(here[0] - at[0], here[1] - at[1], here[2] - at[2]).toFixed(1) : "?"}m`);
    if (verdict !== "ok") return;
    this.marbles.delete(id);
    this.found++;
    this.sendMessage(REMOVE_ITEM, { ItemId: id });
    if (this.marbles.size === 0) {
      this.decided = this.placements("finder");
      this.timer(FINISH_DELAY_SECONDS, () => this.endWith(this.decided!));
    }
  }

  private placements(winner: "hider" | "finder"): Map<RegisteredSession, number> {
    const win = winner === "hider" ? this.hider : this.finder;
    const lose = winner === "hider" ? this.finder : this.hider;
    return new Map([[win.entry, 0], [lose.entry, 1]]);
  }

  private finish(): void {
    const winner = decideWinner(this.hidden, this.found);
    this.log(`over: ${this.found}/${this.hidden} found, ${winner} wins`);
    this.endWith(this.decided ?? this.placements(winner));
  }

  onPlayerQuit(player: PartyGamePlayer): void {
    if (this.decided) {
      this.endWith(this.decided);
      return;
    }
    const stayer = this.players.find((p) => p !== player && !p.left);
    const placements = new Map<RegisteredSession, number>();
    if (stayer) placements.set(stayer.entry, 0);
    // The quitter is still here, and their end screen looks up its own placement.
    placements.set(player.entry, 1);
    this.endWith(placements, new Set([player.entry]));
  }

  // The results list only players still here. (After the last find the
  // decided result stands even if the Finder is the one leaving: they had won.)
  onPlayerLeft(player: PartyGamePlayer): void {
    if (this.decided) {
      this.endWith(new Map([...this.decided].filter(([entry]) => entry !== player.entry)));
      return;
    }
    const stayer = this.players.find((p) => p !== player && !p.left);
    this.endWith(stayer ? new Map([[stayer.entry, 0]]) : new Map());
  }
}
