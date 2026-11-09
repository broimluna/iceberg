// Scheduled party-game lobbies (Dance Battle: Town, every 6 minutes).
//
// A lobby is an MMO item in the room (the client's PartygameLobbyMmoItem):
//   int_a      template id          statetimestamp  start, epoch seconds
//   ttl        lobby seconds        score           {"Players":[{TeamId,RoleId,UserSessionId}]}
// Players join by interacting with it (an `l.a` Interact whose `o` is
// {type: SERVER(1), id: "<item id>"}, as the client's own offline server
// expects), which puts them on the smaller team and equips the lobby prop.
// When time is up the item goes away and, with enough players on both teams,
// the game starts with each player's team and role.
//
// Windows open on multiples of everyXMinutes since the epoch, so every Town
// instance opens its lobby together. State is per room and in memory; a room's
// timers stop when its last player leaves.
import { getByRoom, type RegisteredSession } from "../session-registry.ts";
import type { Session } from "../session.ts";
import type { HandlerContext } from "../handlers/context.ts";
import { getPartyGame, scheduledGames, type PartyGameDef } from "./definitions.ts";
import { addRoomItem, setRoomItemVar, removeRoomItem, ITEM_CATEGORY_PARTY_GAME_LOBBY, type RoomItem } from "./room-items.ts";
import { canStart, isInPartyGame, sessionOf, setPartyGameProp, startPartyGame } from "./manager.ts";
import { TIME_SCALE } from "./session.ts";

// Domain.LocomotionAction bytes.
const LOCOMOTION_ACTION_INTERACT = 2;
const LOCOMOTION_ACTION_CHARGE_THROW = 3;
const LOCOMOTION_ACTION_LAUNCH_THROW = 4;
const LOCOMOTION_ACTION_CANCEL_THROW = 10;
// A charge with no launch or cancel after this long no longer holds a join back.
const MAX_CHARGE_MS = 10_000;
const OBJECT_TYPE_SERVER = 1;
// The game starts a moment after the lobby prop comes off: user-variable
// changes landing in the same client frame as the game start break the client
// (found live with Find Four's invitations).
const START_DELAY_SECONDS = 1;

interface Slot {
  teamId: number;
  roleId: number;
}

interface Member extends Slot {
  entry: RegisteredSession;
}

interface Lobby {
  roomName: string;
  def: PartyGameDef;
  item: RoomItem;
  members: Member[];
  timer: ReturnType<typeof setTimeout>;
}

type Timers = Set<ReturnType<typeof setTimeout>>;

const lobbies = new Map<string, Lobby>(); // by room
const schedules = new Map<string, Timers>(); // by room

const log = (msg: string) => console.log(`[${new Date().toISOString()}] party-game lobby: ${msg}`);

// The window containing nowMs, or else the next one. Windows open on multiples
// of everyMinutes (ms since the epoch) and last lobbySeconds. The client's
// pre-lobby countdown runs to the next multiple plus the lobby length (the
// game start), so the lobby has to be open for the last lobbySeconds of it.
export function nextLobbyWindow(nowMs: number, everyMinutes: number, lobbySeconds: number): { opensAtMs: number; endsAtMs: number } {
  const period = everyMinutes * 60_000;
  let opensAtMs = Math.floor(nowMs / period) * period;
  if (nowMs >= opensAtMs + lobbySeconds * 1000) opensAtMs += period;
  return { opensAtMs, endsAtMs: opensAtMs + lobbySeconds * 1000 };
}

// Smaller team first (ties to team 0), lowest free role; undefined when full.
export function assignSlot(taken: Slot[], perTeam: number, numTeams: number): Slot | undefined {
  const sizes = Array.from({ length: numTeams }, (_, t) => taken.filter((s) => s.teamId === t).length);
  const teamId = sizes.indexOf(Math.min(...sizes));
  if (sizes[teamId]! >= perTeam) return undefined;
  const used = new Set(taken.filter((s) => s.teamId === teamId).map((s) => s.roleId));
  let roleId = 0;
  while (used.has(roleId)) roleId++;
  return { teamId, roleId };
}

// Session ids can exceed 2^53, so the roster is spliced as raw text.
function rosterJson(members: Member[]): string {
  return `{"Players":[${members.map((m) => `{"TeamId":${m.teamId},"RoleId":${m.roleId},"UserSessionId":${m.entry.session.playerSessionId}}`).join(",")}]}`;
}

function roomHasGame(roomName: string, templateId: number): boolean {
  return getByRoom(roomName).some((e) => sessionOf(e.session)?.templateId === templateId);
}

// Opens a lobby in the room: false if the template isn't a scheduled game, or
// the room already has a lobby or a running game of it. ttlSeconds defaults
// to the template's lobby length.
export function openLobby(roomName: string, templateId: number, ttlSeconds?: number): boolean {
  const def = getPartyGame(templateId);
  if (!def || def.launcher?.method !== 1 || !canStart(templateId)) return false;
  if (lobbies.has(roomName) || roomHasGame(roomName, templateId)) return false;
  const lobbyData = def.lobbyData as { LobbyLengthInSeconds: number; LobbyLocation: { x: number; y: number; z: number } };
  const ttl = ttlSeconds ?? lobbyData.LobbyLengthInSeconds * TIME_SCALE;
  const loc = lobbyData.LobbyLocation;
  const item = addRoomItem(roomName, [loc.x, loc.y, loc.z], {
    category: { type: "int", value: ITEM_CATEGORY_PARTY_GAME_LOBBY },
    creator: { type: "int", value: 0 },
    int_a: { type: "int", value: templateId },
    statetimestamp: { type: "string", value: String(Math.floor(Date.now() / 1000)) },
    // An int: the client reads it with IntValue, which throws on a double.
    ttl: { type: "int", value: Math.max(1, Math.round(ttl)) },
    score: { type: "string", value: rosterJson([]) },
  });
  const lobby: Lobby = { roomName, def, item, members: [], timer: setTimeout(() => finish(lobby), ttl * 1000) };
  lobbies.set(roomName, lobby);
  log(`opened in ${roomName} (item #${item.itemId}, ${ttl}s)`);
  return true;
}

function finish(lobby: Lobby): void {
  if (lobbies.get(lobby.roomName) !== lobby) return;
  lobbies.delete(lobby.roomName);
  clearTimeout(lobby.timer);
  removeRoomItem(lobby.item);
  const here = new Set(getByRoom(lobby.roomName));
  const members = lobby.members.filter((m) => here.has(m.entry));
  if (lobby.def.launcher?.lobbyProp) for (const m of members) setPartyGameProp(m.entry, undefined);
  const teams = new Set(members.map((m) => m.teamId));
  if (members.length < lobby.def.minPlayers || teams.size < lobby.def.numTeams) {
    log(`cancelled in ${lobby.roomName}: ${members.length} player(s) on ${teams.size} team(s)`);
    return;
  }
  setTimeout(() => {
    const ready = members.filter((m) => getByRoom(lobby.roomName).includes(m.entry));
    if (!startPartyGame(lobby.def.id, ready.map((m) => m.entry), ready.map(({ teamId, roleId }) => ({ teamId, roleId })))) {
      log(`couldn't start template ${lobby.def.id} in ${lobby.roomName}`);
    }
  }, START_DELAY_SECONDS * 1000 * TIME_SCALE);
}

// The `l.a` hook: an Interact on a lobby item joins the lobby.
export function handleLobbyInteraction(ctx: HandlerContext, action: number, objectJson: string | undefined): void {
  if (action !== LOCOMOTION_ACTION_INTERACT || !objectJson) return;
  let obj: { type?: unknown; id?: unknown };
  try {
    obj = JSON.parse(objectJson);
  } catch {
    return;
  }
  if ((obj?.type !== OBJECT_TYPE_SERVER && obj?.type !== "SERVER") || typeof obj.id !== "string") return;
  const { session } = ctx;
  const lobby = lobbies.get(session.roomName);
  if (!lobby || lobby.item.itemId !== Number(obj.id)) return;
  // Equipping the lobby prop mid-charge locks the thrower in the throw
  // animation, so the join waits for LaunchThrow / CancelThrow.
  if (session.throwChargingSince !== undefined && Date.now() - session.throwChargingSince < MAX_CHARGE_MS) {
    session.pendingLobbyItem = lobby.item.itemId;
    return;
  }
  joinLobby(session, lobby);
}

// l.a actions of the snowball throw.
export function onThrowAction(session: Session, action: number): void {
  if (action === LOCOMOTION_ACTION_CHARGE_THROW) {
    session.throwChargingSince = Date.now();
    return;
  }
  if (action !== LOCOMOTION_ACTION_LAUNCH_THROW && action !== LOCOMOTION_ACTION_CANCEL_THROW) return;
  session.throwChargingSince = undefined;
  const pending = session.pendingLobbyItem;
  session.pendingLobbyItem = undefined;
  const lobby = lobbies.get(session.roomName);
  if (pending !== undefined && lobby?.item.itemId === pending) joinLobby(session, lobby);
}

function joinLobby(session: Session, lobby: Lobby): void {
  session.pendingLobbyItem = undefined;
  const entry = getByRoom(session.roomName).find((e) => e.session === session);
  if (!entry || !session.playerSessionId) return;
  if (isInPartyGame(session) || lobby.members.some((m) => m.entry === entry)) return;
  const slot = assignSlot(lobby.members, lobby.def.maxPlayers / lobby.def.numTeams, lobby.def.numTeams);
  if (!slot) return;
  lobby.members.push({ entry, ...slot });
  if (lobby.def.launcher?.lobbyProp) setPartyGameProp(entry, lobby.def.launcher.lobbyProp);
  setRoomItemVar(lobby.item, "score", { type: "string", value: rosterJson(lobby.members) });
  log(`${session.userName} joined in ${lobby.roomName} (team ${slot.teamId}, role ${slot.roleId})`);
}

// Disconnects (and so room changes, which reconnect).
export function onLobbyPlayerLeft(s: Session): void {
  for (const lobby of lobbies.values()) dropMember(lobby, s);
}

// The client leaves a lobby (its X button) by clearing its own "con", the
// lobby prop. Call before session.heldObject is updated.
export function onLobbyPropPutAway(s: Session, nextName: string | undefined): void {
  if (s.heldObject === undefined || s.heldObject === nextName) return;
  const lobby = lobbies.get(s.roomName);
  if (lobby && lobby.def.launcher?.lobbyProp === s.heldObject) dropMember(lobby, s);
}

function dropMember(lobby: Lobby, s: Session): void {
  const i = lobby.members.findIndex((m) => m.entry.session === s);
  if (i < 0) return;
  lobby.members.splice(i, 1);
  setRoomItemVar(lobby.item, "score", { type: "string", value: rosterJson(lobby.members) });
  log(`${s.userName} left the lobby in ${lobby.roomName}`);
}

// ==================== Schedule ====================

function scheduleNext(roomName: string, def: PartyGameDef, timers: Timers): void {
  const lobbySeconds = (def.lobbyData as { LobbyLengthInSeconds: number }).LobbyLengthInSeconds;
  const now = Date.now();
  const w = nextLobbyWindow(now, def.launcher!.everyXMinutes, lobbySeconds);
  const open = setTimeout(() => {
    timers.delete(open);
    if (schedules.get(roomName) !== timers) return;
    openLobby(roomName, def.id, Math.max(1, (w.endsAtMs - Date.now()) / 1000));
    const next = setTimeout(() => {
      timers.delete(next);
      if (schedules.get(roomName) === timers) scheduleNext(roomName, def, timers);
    }, Math.max(0, w.endsAtMs - Date.now()) + 100);
    timers.add(next);
  }, Math.max(0, w.opensAtMs - now));
  timers.add(open);
}

// Starts a room's lobby schedule when the first player joins it.
// PARTY_GAME_SCHEDULE=off disables it (tests; anything wanting only :dancebattle).
export function ensureRoomLobbies(roomName: string): void {
  if (process.env.PARTY_GAME_SCHEDULE === "off" || schedules.has(roomName)) return;
  const games = scheduledGames().filter((g) => canStart(g.id) && roomName.includes(g.launcher!.scheduledZone!));
  if (games.length === 0) return;
  const timers: Timers = new Set();
  schedules.set(roomName, timers);
  for (const def of games) scheduleNext(roomName, def, timers);
}

// Stops a room's schedule and drops its lobby once nobody is in it.
export function releaseRoomLobbiesIfEmpty(roomName: string): void {
  if (getByRoom(roomName).length > 0) return;
  for (const t of schedules.get(roomName) ?? []) clearTimeout(t);
  schedules.delete(roomName);
  const lobby = lobbies.get(roomName);
  if (lobby) {
    lobbies.delete(roomName);
    clearTimeout(lobby.timer);
    removeRoomItem(lobby.item);
    log(`dropped in empty room ${roomName}`);
  }
}
