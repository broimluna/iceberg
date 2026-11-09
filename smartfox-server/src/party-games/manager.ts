// Party game sessions: start, pgame.message routing, end, rewards.
//
// Wire (client PartyGameService / PartyGameManager):
//   pgame.start.v2 {id int, template int, players: JSON PartyGamePlayerCollection}
//   pgame.message  {id int, type int (PartyGameSessionMessageTypes), message: JSON}
//   pgame.end      {id int, results: JSON [{PlayerSessionId, Placement}]}
// The client starts a game (hides remote players, takes the camera) for any
// pgame.start.v2 it gets, so all three go to the players only. Rewards go
// out as reward.add_delayed; the end popup claims them.
import { SFSObjectWriter, SFSArrayWriter, SFSDataType, encodePacket, type OutgoingPacket, type SFSObjectData } from "../sfs-wire.ts";
import { getUtfString } from "../wire-helpers.ts";
import { getAll, getByRoom, type RegisteredSession } from "../session-registry.ts";
import type { Session } from "../session.ts";
import type { HandlerContext } from "../handlers/context.ts";
import { grantReward, type RewardGrant } from "../webapi-client.ts";
import { withAccount } from "../account.ts";
import { getPartyGame, rewardFor, type PartyGameDef } from "./definitions.ts";
import { host, type PartyGamePlayer, type PartyGameSession, type PartyGameSlot } from "./session.ts";
import { FindFour } from "./find-four.ts";
import { FishBucket } from "./fish-bucket.ts";
import { DanceBattle } from "./dance-battle.ts";
import { TubeRace } from "./tube-race.ts";
import { ScavengerHunt } from "./scavenger-hunt.ts";

export type SessionFactory = (id: number, def: PartyGameDef, players: RegisteredSession[], slots?: PartyGameSlot[]) => PartyGameSession;

const REWARD_SOURCE_MINI_GAME = 5;
const MAX_MESSAGE_BYTES = 4096;

const factories = new Map<number, SessionFactory>();
const sessions = new Map<number, PartyGameSession>();
const sessionByUser = new Map<number, PartyGameSession>();
let nextSessionId = 1;
let granter: (username: string, reward: RewardGrant) => unknown = grantReward;

function log(msg: string): void {
  console.log(`[${new Date().toISOString()}] party-games: ${msg}`);
}

function extensionPacket(cmd: string, p: SFSObjectWriter): OutgoingPacket {
  return encodePacket(1, 13, new SFSObjectWriter().putUtfString("c", cmd).putSFSObject("p", p));
}

export function registerGameType(gameType: number, factory: SessionFactory): void {
  factories.set(gameType, factory);
}

// Tests only.
export function setRewardGranter(fn: (username: string, reward: RewardGrant) => unknown): void {
  granter = fn;
}

// Invitation games have a trigger prop (Find Four also a player prop);
// lobby-launched ones (launcher method 1, ZoneSchedule: Dance Battle)
// have neither.
function startable(def: PartyGameDef | undefined): def is PartyGameDef {
  return !!def && (!!def.playerProp || !!def.launcher?.triggerProp || def.launcher?.method === 1) && factories.has(def.gameType);
}

export function canStart(templateId: number): boolean {
  return startable(getPartyGame(templateId));
}

export function isInPartyGame(s: Session): boolean {
  return sessionByUser.has(s.userId);
}

// Whether startPartyGame(templateId, players) would start: a known game,
// the right player count, each player connected, distinct, with a session
// id and not already in a game.
export function canStartWith(templateId: number, players: RegisteredSession[]): boolean {
  const def = getPartyGame(templateId);
  if (!startable(def)) return false;
  if (players.length < def.minPlayers || players.length > def.maxPlayers) return false;
  if (new Set(players.map((p) => p.session.userId)).size !== players.length) return false;
  const connected = new Set(getAll().map((e) => e.session));
  return players.every((p) => connected.has(p.session) && !!p.session.playerSessionId && !sessionByUser.has(p.session.userId));
}

export function sessionOf(s: Session): PartyGameSession | undefined {
  return sessionByUser.get(s.userId);
}

// Runs a game callback; a throw ends the game with no results (the
// client's balk path) so nobody is left waiting.
export function guarded(game: PartyGameSession, fn: () => void): void {
  try {
    fn();
  } catch (err) {
    log(`session ${game.id} threw: ${(err as Error).stack ?? err}`);
    endSession(game, new Map());
  }
}

// "con" {type: "pgame", name} with no con_prop: the client raises
// PARTYGAME_EQUIPPED for it.
export function setPartyGameProp(entry: RegisteredSession, name: string | undefined): void {
  const s = entry.session;
  s.heldObject = name;
  const v = new SFSArrayWriter().putUtfString("con");
  if (name) v.putVariableType("object").putSFSObject(new SFSObjectWriter().putUtfString("type", "pgame").putUtfString("name", name));
  else v.putVariableType("null").putNull();
  v.putBool(false);
  const packet = encodePacket(0, 12, new SFSObjectWriter().putInt("u", s.userId).putSFSArray("vl", new SFSArrayWriter().putSFSArray(v)));
  for (const target of getByRoom(s.roomName)) target.send(packet);
}

function present(game: PartyGameSession): RegisteredSession[] {
  return game.players.filter((p) => !p.left && !p.released).map((p) => p.entry);
}

// `slots[i]` is players[i]'s team and role in the player list the client gets.
export function startPartyGame(templateId: number, players: RegisteredSession[], slots?: PartyGameSlot[]): PartyGameSession | undefined {
  const def = getPartyGame(templateId);
  const factory = def ? factories.get(def.gameType) : undefined;
  if (!def || !factory || slots && slots.length !== players.length || !canStartWith(templateId, players)) {
    log(`can't start template ${templateId} with ${players.map((p) => p.session.userName).join(", ")}`);
    return undefined;
  }
  const game = factory(nextSessionId++, def, players, slots);
  sessions.set(game.id, game);
  for (const p of players) sessionByUser.set(p.session.userId, game);
  if (def.playerProp) for (const p of players) setPartyGameProp(p, def.playerProp);
  // Session ids can exceed 2^53, so they're spliced in as raw text.
  const playerData = `{"Players":[${players.map((p, i) => `{"TeamId":${slots?.[i]?.teamId ?? 0},"UserSessionId":${p.session.playerSessionId},"RoleId":${slots?.[i]?.roleId ?? 0}}`).join(",")}]}`;
  const start = extensionPacket("pgame.start.v2",
    new SFSObjectWriter().putInt("id", game.id).putInt("template", templateId).putUtfString("players", playerData));
  for (const p of players) p.send(start);
  log(`session ${game.id} (template ${templateId}) started: ${players.map((p) => p.session.userName).join(", ")}`);
  guarded(game, () => game.onStart());
  return game;
}

function messagePacket(game: PartyGameSession, type: number, message: string): OutgoingPacket {
  return extensionPacket("pgame.message",
    new SFSObjectWriter().putInt("id", game.id).putInt("type", type).putUtfString("message", message));
}

export function sendGameMessage(game: PartyGameSession, type: number, message: string): void {
  if (game.ended) return;
  const packet = messagePacket(game, type, message);
  for (const p of present(game)) p.send(packet);
}

export function sendGameMessageTo(game: PartyGameSession, entry: RegisteredSession, type: number, message: string): void {
  if (game.ended || !present(game).includes(entry)) return;
  entry.send(messagePacket(game, type, message));
}

// An empty-results pgame.end to one player: the client tears the session down
// (controls back, HUD gone) and ignores everything after. The session stays
// open for the rest.
export function releasePlayer(game: PartyGameSession, player: PartyGamePlayer): void {
  if (game.ended || player.left || player.released) return;
  player.released = true;
  player.entry.send(extensionPacket("pgame.end", new SFSObjectWriter().putInt("id", game.id).putUtfString("results", "[]")));
  if (sessionByUser.get(player.entry.session.userId) === game) sessionByUser.delete(player.entry.session.userId);
  const prop = game.gamePropFor(player);
  if (prop && player.entry.session.heldObject === prop) setPartyGameProp(player.entry, undefined);
  log(`${player.entry.session.userName} released from session ${game.id}`);
}

export function endSession(game: PartyGameSession, placements: Map<RegisteredSession, number>, unpaid?: Set<RegisteredSession>): void {
  if (game.ended) return;
  game.ended = true;
  game.clearTimers();
  const here = present(game);
  const results = [...placements].map(([p, place]) => `{"PlayerSessionId":${p.session.playerSessionId},"Placement":${place}}`);
  const end = extensionPacket("pgame.end", new SFSObjectWriter().putInt("id", game.id).putUtfString("results", `[${results.join(",")}]`));
  for (const p of here) p.send(end);
  for (const p of game.players) {
    const prop = game.gamePropFor(p);
    if (prop && !p.left && !p.released && p.entry.session.heldObject === prop) setPartyGameProp(p.entry, undefined);
  }

  for (const [p, place] of placements) {
    const reward = rewardFor(game.def, place);
    if (!reward || !p.session.playerSessionId || unpaid?.has(p)) continue;
    withAccount(p.session, `party game ${game.id} reward`, (account) => granter(account, reward));
    const payload = `{"goodUntil":0,"signature":"","swid":"","data":{"source":${REWARD_SOURCE_MINI_GAME},"sourceId":"${game.id}","rewards":{"${p.session.playerSessionId}":${JSON.stringify(reward)}}}}`;
    if (here.includes(p)) p.send(extensionPacket("reward.add_delayed", new SFSObjectWriter().putUtfString("reward", payload)));
  }

  try {
    game.onEnded();
  } catch (err) {
    log(`session ${game.id} onEnded threw: ${(err as Error).stack ?? err}`);
  }

  sessions.delete(game.id);
  for (const p of game.players) if (sessionByUser.get(p.entry.session.userId) === game) sessionByUser.delete(p.entry.session.userId);
  log(`session ${game.id} ended: ${[...placements].map(([p, place]) => `${p.session.userName}=${place}`).join(", ") || "no results"}`);
}

// The client's serialize() has no int overload, so its ints arrive as LONG.
function getWholeNumber(obj: SFSObjectData, key: string): number | undefined {
  const v = obj[key];
  if (v?.type === SFSDataType.LONG) {
    return v.value >= BigInt(Number.MIN_SAFE_INTEGER) && v.value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v.value) : undefined;
  }
  if (v?.type === SFSDataType.INT || v?.type === SFSDataType.SHORT || v?.type === SFSDataType.BYTE) return v.value;
  return undefined;
}

// "pgame.message" from a client: {id (long), type (long), message}.
export function handlePartyGameMessage(innerParams: SFSObjectData, ctx: HandlerContext): void {
  const id = getWholeNumber(innerParams, "id");
  const type = getWholeNumber(innerParams, "type");
  const text = getUtfString(innerParams, "message");
  const game = id === undefined ? undefined : sessions.get(id);
  const player = game?.players.find((p) => p.entry.session === ctx.session && !p.left);
  if (!game || !player || type === undefined || text === undefined) {
    log(`${ctx.peer} - pgame.message for session ${id} ignored (not a player, or missing fields)`);
    return;
  }
  if (Buffer.byteLength(text) > MAX_MESSAGE_BYTES) {
    log(`${ctx.peer} - pgame.message over ${MAX_MESSAGE_BYTES} bytes ignored`);
    return;
  }
  let message: unknown;
  try {
    message = JSON.parse(text);
  } catch {
    log(`${ctx.peer} - pgame.message with bad JSON ignored`);
    return;
  }
  guarded(game, () => game.onMessage(player, type, message));
}

// The client quits a party game by clearing its own "con" (the game prop);
// it stays in the game until pgame.end arrives.
export function onPartyGamePlayerQuit(s: Session): void {
  const game = sessionByUser.get(s.userId);
  const player = game?.players.find((p) => p.entry.session === s && !p.left);
  if (!game || !player || game.ended) return;
  log(`${s.userName} quit session ${game.id}`);
  guarded(game, () => game.onPlayerQuit(player));
}

// The `l.a` hook: a player's reported position, for games that track movement.
export function onPartyGamePlayerMoved(s: Session, position: [number, number, number]): void {
  const game = sessionByUser.get(s.userId);
  const player = game?.players.find((p) => p.entry.session === s && !p.left);
  if (!game || !player || game.ended) return;
  guarded(game, () => game.onPlayerMoved(player, position));
}

// The `l.a` hook for action bytes (before onPartyGamePlayerMoved for the
// same packet, so a game can compare with the previous position).
export function onPartyGameAction(s: Session, action: number, position: [number, number, number]): void {
  const game = sessionByUser.get(s.userId);
  const player = game?.players.find((p) => p.entry.session === s && !p.left);
  if (!game || !player || game.ended) return;
  guarded(game, () => game.onAction(player, action, position));
}

// Disconnects (and so room changes, which reconnect).
export function onPartyGamePlayerLeft(s: Session): void {
  const game = sessionByUser.get(s.userId);
  if (!game) return;
  sessionByUser.delete(s.userId);
  const player = game.players.find((p) => p.entry.session === s);
  if (!player || player.left || game.ended) return;
  player.left = true;
  log(`${s.userName} left session ${game.id}`);
  guarded(game, () => game.onPlayerLeft(player));
}

// "loc": PlayerStateService's Domain.LocomotionState byte (2 = GenericState1,
// the locked party-game pose).
export function setPartyGameLocomotion(entry: RegisteredSession, state: number): void {
  const s = entry.session;
  s.locomotionState = state;
  const v = new SFSArrayWriter().putUtfString("loc").putVariableType("int").putInt(state).putBool(false);
  const packet = encodePacket(0, 12, new SFSObjectWriter().putInt("u", s.userId).putSFSArray("vl", new SFSArrayWriter().putSFSArray(v)));
  for (const target of getByRoom(s.roomName)) target.send(packet);
}

host.end = endSession;
host.release = releasePlayer;
host.setProp = setPartyGameProp;
host.setLocomotion = setPartyGameLocomotion;
host.guarded = guarded;
host.send = sendGameMessage;
host.sendTo = sendGameMessageTo;

registerGameType(0, (id, def, players, slots) => new ScavengerHunt(id, def, players, slots));
registerGameType(1, (id, def, players) => new FishBucket(id, def, players));
registerGameType(2, (id, def, players) => new FindFour(id, def, players));
registerGameType(3, (id, def, players, slots) => new DanceBattle(id, def, players, slots));
registerGameType(4, (id, def, players, slots) => new TubeRace(id, def, players, slots));
registerGameType(5, (id, def, players, slots) => new TubeRace(id, def, players, slots));
