// Island Targets (Crate Co's snowball targets at Mt Blizzard), per room.
//
// The client has no target command: the server runs the game from Disney's
// IslandTargets data and the room MMO items (party-games/room-items.ts, so
// join snapshots come free):
//   category 4 group (one phase)  path, timestamp = Starts ms, statetimestamp = Expires ms
//   category 3 target             path, int_a = HitCapacity, actioncount = HitCount
//   category 5 playground stats   path, int_a = current win streak, actioncount = best today
// all with creator 0 (retail ClubPenguin.Net.Domain *MMOItem / ItemFactory).
//
// Client flow (IslandTargetPlaygroundController): a group add starts a round
// 3 s later; a target whose HitCount reaches its capacity falls; all down
// ends the round; the group's removal while the round runs is a timeout.
// After the final round the client claims a delayed MINI_GAME reward
// ("Targets") 4 s after the win, so the server sends it at once.
//
// Hits come from the thrower's l.a LaunchThrow (rules.ts traceThrow), are
// counted when the snowball would land, and are logged as [TARGETS].
import { SFSObjectWriter, encodePacket, type OutgoingPacket } from "../sfs-wire.ts";
import { getByRoom, type RegisteredSession } from "../session-registry.ts";
import { zoneOfRoom } from "../scene-switches.ts";
import { withAccount } from "../account.ts";
import { grantReward, type RewardGrant } from "../webapi-client.ts";
import { addRoomItem, removeRoomItem, setRoomItemVar, type RoomItem } from "../party-games/room-items.ts";
import { contentDateOf, playgrounds, type PlaygroundData, type SupersetData, type TargetData, type Vec3 } from "../world-data.ts";
import { createPicker } from "../selection.ts";
import type { Session } from "../session.ts";
import { logSafe } from "../log-safe.ts";
import {
  insideSphere, MIN_THROW_GAP_MS, nextGameStartMs, splitReward, targetHp, throwGuard, traceThrow,
} from "./rules.ts";

const CATEGORY_TARGET = 3;
const CATEGORY_GROUP = 4;
const CATEGORY_STATS = 5;
const ACTION_LAUNCH_THROW = 4;
const REWARD_SOURCE_MINI_GAME = 5;
const REWARD_SOURCE_ID = "Targets";
// The client's delayBetweenRounds, and how long a won round stays up.
const ROUND_DELAY_SECONDS = 3;
const WON_ROUND_LINGER_SECONDS = 2;

// Multiplies every delay (tests).
const TIME_SCALE = (() => {
  const v = Number(process.env.ISLAND_TARGETS_TIME_SCALE);
  return Number.isFinite(v) && v > 0 ? v : 1;
})();
const scaled = (seconds: number) => seconds * 1000 * TIME_SCALE;

let granter: (username: string, reward: RewardGrant) => unknown = grantReward;
export function setTargetsRewardGranter(fn: (username: string, reward: RewardGrant) => unknown): void {
  granter = fn;
}

interface LiveTarget { data: TargetData; item: RoomItem; capacity: number; hits: number }

interface Game {
  superset: SupersetData;
  phaseIndex: number;
  // Bumped each phase, so a snowball in flight can't land in the next one.
  serial: number;
  group?: RoomItem;
  targets: LiveTarget[];
  startsMs: number;
  roundOver: boolean;
  hitsByUser: Map<number, number>;
}

interface Playground {
  roomName: string;
  data: PlaygroundData;
  pick: () => number;
  stats: RoomItem;
  current: number;
  best: number;
  day: string;
  game?: Game;
  lastThrowMs: Map<number, number>;
  timers: Set<NodeJS.Timeout>;
}

const rooms = new Map<string, Playground[]>();

// Player names and room names go through logSafe.
function log(msg: string): void {
  console.log(`[${new Date().toISOString()}] [TARGETS] ${msg}`);
}

function after(pg: Playground, ms: number, fn: () => void): NodeJS.Timeout {
  const timer = setTimeout(() => {
    pg.timers.delete(timer);
    try {
      fn();
    } catch (err) {
      log(`timer threw in ${logSafe(pg.roomName)}: ${(err as Error).stack ?? err}`);
    }
  }, ms);
  pg.timers.add(timer);
  return timer;
}

const int = (value: number) => ({ type: "int" as const, value });
const str = (value: string) => ({ type: "string" as const, value });
const utcDay = (ms = Date.now()) => new Date(ms).toISOString().slice(0, 10);

// ==================== Stats (win streak) ====================

function setStats(pg: Playground, current: number, best: number): void {
  if (pg.current !== current) setRoomItemVar(pg.stats, "int_a", int(current));
  if (pg.best !== best) setRoomItemVar(pg.stats, "actioncount", int(best));
  pg.current = current;
  pg.best = best;
}

// "Best today" and the streak start over at UTC midnight.
function rollDay(pg: Playground): void {
  const today = utcDay();
  if (pg.day === today) return;
  pg.day = today;
  setStats(pg, 0, 0);
}

// ==================== Rooms ====================

export function ensureRoomPlaygrounds(roomName: string): void {
  if (rooms.has(roomName)) return;
  const list: Playground[] = [];
  rooms.set(roomName, list);
  for (const data of playgrounds(zoneOfRoom(roomName), contentDateOf(roomName))) {
    const stats = addRoomItem(roomName, data.position, {
      category: int(CATEGORY_STATS), creator: int(0), path: str(data.path), int_a: int(0), actioncount: int(0),
    });
    const pg: Playground = {
      roomName, data, stats, pick: createPicker(data.behaviour, data.supersets.length),
      current: 0, best: 0, day: utcDay(), lastThrowMs: new Map(), timers: new Set(),
    };
    list.push(pg);
    if (process.env.ISLAND_TARGETS_SCHEDULE !== "off") scheduleNext(pg);
  }
}

// Games start on the clock tower's multiples of everyXMinutes after the hour.
// A start that finds a game still running is skipped.
function scheduleNext(pg: Playground): void {
  const now = Date.now();
  const startMs = nextGameStartMs(now, pg.data.everyXMinutes);
  after(pg, (startMs - now) * TIME_SCALE, () => {
    if (!pg.game) startGame(pg);
    scheduleNext(pg);
  });
}

export function releaseRoomPlaygroundsIfEmpty(roomName: string): void {
  const list = rooms.get(roomName);
  if (!list || getByRoom(roomName).length > 0) return;
  for (const pg of list) {
    for (const timer of pg.timers) clearTimeout(timer);
    pg.timers.clear();
    if (pg.game) removeRound(pg.game);
    pg.game = undefined;
    removeRoomItem(pg.stats);
  }
  rooms.delete(roomName);
}

export function startGameNow(roomName: string): "started" | "no-playground" | "running" {
  const pg = rooms.get(roomName)?.[0];
  if (!pg) return "no-playground";
  if (pg.game) return "running";
  startGame(pg);
  return "started";
}

export function playgroundStats(): { rooms: number; timers: number } {
  let timers = 0;
  for (const list of rooms.values()) for (const pg of list) timers += pg.timers.size;
  return { rooms: rooms.size, timers };
}

// ==================== A game ====================

function startGame(pg: Playground): void {
  rollDay(pg);
  const superset = pg.data.supersets[pg.pick()]!;
  pg.game = { superset, phaseIndex: 0, serial: 0, targets: [], startsMs: 0, roundOver: false, hitsByUser: new Map() };
  log(`game started in ${logSafe(pg.roomName)}: ${superset.path}`);
  startPhase(pg, pg.game);
}

function playersInZone(pg: Playground): RegisteredSession[] {
  const zone = pg.data.rewardsVolume;
  return getByRoom(pg.roomName).filter((e) => e.session.lastPosition && insideSphere(e.session.lastPosition, zone.center, zone.radius));
}

function startPhase(pg: Playground, game: Game): void {
  const phase = game.superset.phases[game.phaseIndex]!;
  const present = playersInZone(pg).length;
  game.serial++;
  game.roundOver = false;
  game.startsMs = Date.now() + scaled(ROUND_DELAY_SECONDS);
  const expiresMs = game.startsMs + scaled(phase.sessionSeconds);
  game.group = addRoomItem(pg.roomName, phase.position, {
    category: int(CATEGORY_GROUP), creator: int(0), path: str(phase.path),
    timestamp: str(String(game.startsMs)), statetimestamp: str(String(expiresMs)),
  });
  game.targets = phase.targets.map((data) => {
    const capacity = targetHp(data.minHits, data.populationMultiplier, present);
    const item = addRoomItem(pg.roomName, data.position, {
      category: int(CATEGORY_TARGET), creator: int(0), path: str(data.path), int_a: int(capacity), actioncount: int(0),
    });
    return { data, item, capacity, hits: 0 };
  });
  const serial = game.serial;
  after(pg, expiresMs - Date.now(), () => {
    if (pg.game === game && game.serial === serial && !game.roundOver) timeOut(pg, game);
  });
}

function removeRound(game: Game): void {
  if (game.group) removeRoomItem(game.group);
  for (const t of game.targets) removeRoomItem(t.item);
  game.group = undefined;
  game.targets = [];
}

function timeOut(pg: Playground, game: Game): void {
  game.roundOver = true;
  removeRound(game);
  pg.game = undefined;
  setStats(pg, 0, pg.best);
  log(`game timed out in ${logSafe(pg.roomName)} at phase ${game.phaseIndex + 1}`);
}

function applyHit(pg: Playground, game: Game, target: LiveTarget, userId: number): void {
  target.hits++;
  setRoomItemVar(target.item, "actioncount", int(target.hits));
  game.hitsByUser.set(userId, (game.hitsByUser.get(userId) ?? 0) + 1);
  if (game.targets.some((t) => t.hits < t.capacity)) return;

  game.roundOver = true;
  const last = game.phaseIndex === game.superset.phases.length - 1;
  if (last) win(pg, game);
  const serial = game.serial;
  after(pg, scaled(WON_ROUND_LINGER_SECONDS), () => {
    if (game.serial !== serial) return;
    removeRound(game);
    if (pg.game !== game) return;
    if (last) {
      pg.game = undefined;
      return;
    }
    game.phaseIndex++;
    startPhase(pg, game);
  });
}

function extensionPacket(cmd: string, p: SFSObjectWriter): OutgoingPacket {
  return encodePacket(1, 13, new SFSObjectWriter().putUtfString("c", cmd).putSFSObject("p", p));
}

// The final target fell: streak, then rewards for everyone in the zone who
// landed a hit this game, shared out per the superset's totals.
function win(pg: Playground, game: Game): void {
  rollDay(pg);
  setStats(pg, pg.current + 1, Math.max(pg.best, pg.current + 1));
  const eligible = playersInZone(pg).filter((e) => (game.hitsByUser.get(e.session.userId) ?? 0) > 0);
  const reward = splitReward(game.superset.totalReward, game.superset.minPerPlayerReward, eligible.length);
  for (const e of eligible) {
    const sid = e.session.playerSessionId;
    if (!sid) continue;
    withAccount(e.session, "island targets reward", (account) => granter(account, reward));
    const payload = `{"goodUntil":0,"signature":"","swid":"","data":{"source":${REWARD_SOURCE_MINI_GAME},"sourceId":"${REWARD_SOURCE_ID}","rewards":{"${sid}":${JSON.stringify(reward)}}}}`;
    e.send(extensionPacket("reward.add_delayed", new SFSObjectWriter().putUtfString("reward", payload)));
  }
  log(`game won in ${logSafe(pg.roomName)}: streak ${pg.current}, best ${pg.best}, paid ${eligible.map((e) => logSafe(e.session.userName)).join(", ") || "nobody"}`);
}

// ==================== Throws ====================

export function onIslandTargetThrow(s: Session, action: number, previous: number[] | undefined, p: number[], v: number[] | undefined): void {
  if (action !== ACTION_LAUNCH_THROW || !v) return;
  const pg = rooms.get(s.roomName)?.find((x) => x.game?.group && !x.game.roundOver);
  const game = pg?.game;
  if (!pg || !game) return;
  const now = Date.now();
  const say = (nearest: string, dist: number, t: number, hit: boolean, reason: string) =>
    log(`throw user=${logSafe(s.userName)} nearest=${nearest} dist=${dist.toFixed(2)} t=${t.toFixed(2)} hit=${hit ? "yes" : "no"} reason=${reason}`);

  const guard = now < game.startsMs ? "early" : throwGuard(now, p, v, previous, pg.lastThrowMs.get(s.userId), MIN_THROW_GAP_MS * TIME_SCALE);
  const live = game.targets.filter((t) => t.hits < t.capacity);
  const trace = guard === "invalid" ? {} : traceThrow(p as Vec3, v as Vec3, live.map((t) => ({ path: t.data.path, center: t.data.hitSphere.center, radius: t.data.hitSphere.radius })));
  const nearest = trace.nearest ?? { path: "-", dist: NaN, t: 0 };
  if (guard) return say(nearest.path, nearest.dist, nearest.t, false, guard);
  pg.lastThrowMs.set(s.userId, now);
  if (!trace.hit) return say(nearest.path, nearest.dist, nearest.t, false, "miss");
  say(trace.hit.path, nearest.dist, trace.hit.t, true, "ok");

  const target = live.find((t) => t.data.path === trace.hit!.path)!;
  const serial = game.serial;
  after(pg, scaled(trace.hit.t), () => {
    if (pg.game !== game || game.serial !== serial || game.roundOver || target.hits >= target.capacity) return;
    applyHit(pg, game, target, s.userId);
  });
}
