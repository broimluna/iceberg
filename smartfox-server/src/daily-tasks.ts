// Daily challenges. The server does the counting: the retail client only
// displays progress and saves nothing itself. When an event counts for a
// task, the WebAPI applies it (task-increment: Task.Increment with
// CounterMax, reset each UTC day) and returns the new counter, which goes to
// the client as "task.c" {t: task id, c: counter}. The WebAPI's database is
// the only copy of progress, so nothing the client sends can set it; the
// day's list comes back as joinRoomData.playerRoomData.dailyTaskProgress.
//
// Community tasks (TaskDefinition.Group 2, e.g. "the world sends 10,000
// hearts") share one counter between all players, and every change goes to
// everyone connected.
//
// Task definitions and their watchers are generated from the game's task
// assets (data/daily-tasks.json). A watcher counts an event; its type and
// parameters follow the client's TaskWatcher.GetExportParameters. Watchers
// with a criteriaSwitch only count while a scene switch (usually "player is
// inside this volume") is on; switch watchers count a scene switch turning
// on, and room watchers count enough players having switches on at once
// (scene-switches.ts evaluates the switches).
//
// Every task is tracked, not only the day's: the client applies task.c only
// to tasks it has loaded for its content date and ignores the rest.

import data from "../data/daily-tasks.json" with { type: "json" };
import { SFSObjectWriter, encodePacket, type OutgoingPacket } from "./sfs-wire.ts";
import { incrementTask } from "./webapi-client.ts";
import { getAll, getByRoom } from "./session-registry.ts";
import type { Session } from "./session.ts";
import {
  PlayerSwitches,
  countedParts,
  parseOutfit,
  pathSamples,
  sticksOn,
  zoneOfRoom,
  zoneSwitches,
  type PlayerInputs,
  type SwitchNode,
} from "./scene-switches.ts";

interface Watcher {
  type: string;
  criteriaSwitch?: string;
  actions?: number[];
  consumables?: string[];
  matchType?: number;
  matchCounting?: number;
  texts?: string[];
  emotes?: number[];
  sizzleClips?: number[];
  loot?: string[];
  path?: string;
  switch?: string;
  // Room watchers (UserGroupWatcher): operator 0 OR, 1 AND.
  operator?: number;
  switches?: { minUserCount: number; switch: string }[];
}

interface TaskDef {
  // TaskDefinition.TaskGroup: 0 Individual, 1 Teamwork, 2 Community.
  group: number;
  threshold: number;
  watchers: Watcher[];
}

interface Target {
  send: (packet: OutgoingPacket) => void;
  session: Session;
}

const TASKS = data.tasks as Record<string, TaskDef>;
const EMOTE_CODES = new Set<number>(data.emoteCharacterCodes);

// Chat watcher ExpressionMatchType / ExpressionMatchCounting.
const MATCH_ANY = 0;
const MATCH_ALL = 1;
const MATCH_ONLY = 2;
const ONE_PER_MESSAGE = 0;

const GROUP_COMMUNITY = 2;

// LocomotionAction bytes.
const LOCOMOTION_MOVE = 0;
const LOCOMOTION_INTERACT = 2;

function taskCountPacket(taskId: string, counter: number): OutgoingPacket {
  const p = new SFSObjectWriter().putUtfString("t", taskId).putInt("c", counter);
  return encodePacket(1, 13, new SFSObjectWriter().putUtfString("c", "task.c").putSFSObject("p", p));
}

async function increment(target: Target, taskId: string, times: number): Promise<void> {
  const def = TASKS[taskId];
  if (!def || times <= 0) return;
  const result = await incrementTask(target.session.userName, taskId, times);
  if (!result || !result.changed) return;
  const packet = taskCountPacket(taskId, result.counter);
  if (def.group === GROUP_COMMUNITY) {
    for (const entry of getAll()) entry.send(packet);
  } else {
    target.send(packet);
  }
  console.log(`[${new Date().toISOString()}] ${target.session.userName} <- task.c (${taskId} = ${result.counter}${def.group === GROUP_COMMUNITY ? ", community" : ""})`);
  // TaskCompletionWatcher counts the player's own completed tasks.
  if (result.completed && def.group !== GROUP_COMMUNITY) {
    forEachWatcher("taskCompletion", (id) => (id === taskId ? 0 : 1), target);
  }
}

// Runs every watcher of one type. count returns how many times the
// watcher's task is incremented. A watcher with a criteriaSwitch counts only
// while that switch is on for the player.
function forEachWatcher(type: string, count: (taskId: string, watcher: Watcher) => number, target: Target): void {
  for (const [taskId, def] of Object.entries(TASKS)) {
    for (const watcher of def.watchers) {
      if (watcher.type !== type) continue;
      if (watcher.criteriaSwitch && !switchesFor(target.session).criteriaOn(watcher)) continue;
      const times = count(taskId, watcher);
      if (times > 0) void increment(target, taskId, times);
    }
  }
}

// ==================== Scene switches ====================

const switchState = new WeakMap<Session, PlayerSwitches>();

// The player's switches for the zone they're in. A new room starts with
// every switch off, as the client's do when the scene loads.
function switchesFor(session: Session): PlayerSwitches {
  const zone = zoneOfRoom(session.roomName);
  let sw = switchState.get(session);
  if (!sw || sw.zone !== zone) {
    sw = new PlayerSwitches(zone);
    switchState.set(session, sw);
  }
  return sw;
}

function inputsOf(session: Session, position = session.lastPosition): PlayerInputs {
  return {
    position,
    locomotionState: session.locomotionState,
    held: session.heldObject,
    outfit: parseOutfit(session.outfitJson),
    tube: session.selectedTubeId,
    colour: session.colour,
    lastInteraction: session.lastInteraction,
  };
}

// Switch watchers per zone. "parts" is set when the task counts parts (see
// countedParts in scene-switches.ts).
interface SwitchWatcherRef {
  taskId: string;
  watcher: Watcher;
  parts?: SwitchNode[];
}
const switchWatchersByZone = new Map<string, SwitchWatcherRef[]>();

function switchWatchers(zone: string): SwitchWatcherRef[] {
  let list = switchWatchersByZone.get(zone);
  if (list) return list;
  list = [];
  const trees = zoneSwitches(zone) ?? {};
  for (const [taskId, def] of Object.entries(TASKS)) {
    for (const watcher of def.watchers) {
      if (watcher.type !== "switch" || !watcher.switch) continue;
      const root = trees[watcher.switch];
      if (!root) continue;
      const counted = def.threshold > 1 && !watcher.criteriaSwitch && sticksOn(root);
      const parts = counted ? countedParts(root) : [];
      list.push({ taskId, watcher, parts: parts.length ? parts : undefined });
    }
  }
  switchWatchersByZone.set(zone, list);
  return list;
}

// Parts already counted, per player and task, for the current UTC day.
const countedToday = new Map<string, Set<string>>();
let countedDay = "";

function countedSet(session: Session, taskId: string): Set<string> {
  const day = new Date().toISOString().slice(0, 10);
  if (day !== countedDay) {
    countedToday.clear();
    countedDay = day;
  }
  const key = `${session.userName}\n${taskId}`;
  let set = countedToday.get(key);
  if (!set) countedToday.set(key, (set = new Set()));
  return set;
}

// Room watchers' last result, per room and watcher.
const roomWatcherOn = new Map<string, boolean>();

function targetOf(session: Session): Target | undefined {
  return getAll().find((e) => e.session === session);
}

function hasSwitches(sw: PlayerSwitches): boolean {
  return Object.keys(sw.trees).length > 0;
}

// Re-evaluates the player's switches at each position (the path of a move,
// or the current position) and counts what turned on.
function refresh(target: Target, positions: (number[] | undefined)[] = [target.session.lastPosition]): void {
  const sw = switchesFor(target.session);
  if (!hasSwitches(sw)) return;
  for (const position of positions) settle(target, sw, inputsOf(target.session, position));
  checkRoomWatchers(target.session.roomName);
}

function settle(target: Target, sw: PlayerSwitches, inputs: PlayerInputs): void {
  // A switch turning on can enable or disable a WatcherSwitch, which can
  // change other switches; a few rounds settle it.
  for (let round = 0; round < 4; round++) {
    const changes = sw.evaluate(inputs);
    const risen = new Set(changes.filter((c) => c.after && !c.before).map((c) => c.name));
    for (const ref of switchWatchers(sw.zone)) {
      if (ref.parts) {
        const counted = countedSet(target.session, ref.taskId);
        let fresh = 0;
        for (const part of ref.parts) {
          if (sw.nodeOn(part) && !counted.has(part.path)) {
            counted.add(part.path);
            fresh++;
          }
        }
        if (fresh > 0) void increment(target, ref.taskId, fresh);
      } else if (risen.has(ref.watcher.switch!) && sw.criteriaOn(ref.watcher)) {
        void increment(target, ref.taskId, 1);
      }
    }
    if (risen.size === 0 || !sw.applyWatcherEvent((w) => w.type === "switch" && risen.has(w.switch))) break;
  }
}

// UserGroupWatcher: each listed switch needs at least minUserCount players
// in the room with it on (operator 0 OR, 1 AND). When that becomes true,
// every player in the room with one of the switches on gets the count.
const roomWatchersByZone = new Map<string, { taskId: string; watcher: Watcher; index: number }[]>();

function roomWatchers(zone: string): { taskId: string; watcher: Watcher; index: number }[] {
  let list = roomWatchersByZone.get(zone);
  if (list) return list;
  list = [];
  const trees = zoneSwitches(zone) ?? {};
  for (const [taskId, def] of Object.entries(TASKS)) {
    def.watchers.forEach((watcher, index) => {
      if (watcher.type === "room" && watcher.switches?.length && watcher.switches.every((s) => s.switch in trees)) {
        list!.push({ taskId, watcher, index });
      }
    });
  }
  roomWatchersByZone.set(zone, list);
  return list;
}

function checkRoomWatchers(roomName: string): void {
  const list = roomWatchers(zoneOfRoom(roomName));
  if (list.length === 0) return;
  const players = getByRoom(roomName);
  for (const { taskId, watcher, index } of list) {
    const switches = watcher.switches!;
    const eligible = players.filter((p) => switchesFor(p.session).criteriaOn(watcher));
    const results = switches.map(
      (s) => eligible.filter((p) => switchesFor(p.session).isOn(s.switch)).length >= Math.max(1, s.minUserCount),
    );
    const on = watcher.operator === 0 ? results.some(Boolean) : results.every(Boolean);
    const key = `${roomName}\n${taskId}\n${index}`;
    if (on === (roomWatcherOn.get(key) === true)) continue;
    if (!on) {
      roomWatcherOn.delete(key);
      continue;
    }
    roomWatcherOn.set(key, true);
    for (const p of eligible) {
      if (switches.some((s) => switchesFor(p.session).isOn(s.switch))) void increment(p, taskId, 1);
    }
  }
}

// Runs a watcher event through the player's WatcherSwitches.
function watcherEvent(target: Target, match: (w: Watcher) => boolean): void {
  const sw = switchesFor(target.session);
  if (hasSwitches(sw) && sw.applyWatcherEvent(match)) refresh(target);
}

// ==================== Events ====================

// l.a: position, the locomotion action byte (Move 0, Jump 1, Interact 2,
// LaunchThrow 4, Torpedo 5, Action1-3 7-9) and, for Interact, the
// ActionedObject JSON {type, id, tag} (type 0 LOCAL: id is the scene path).
export function onLocomotion(target: Target, previous: number[] | undefined, position: number[], action: number, objectJson?: string): void {
  let interacted: string | undefined;
  if (action === LOCOMOTION_INTERACT && objectJson) {
    try {
      const obj = JSON.parse(objectJson);
      if ((obj?.type === 0 || obj?.type === "LOCAL") && typeof obj.id === "string") interacted = obj.id;
    } catch {
      // Not JSON.
    }
  }
  if (interacted !== undefined) target.session.lastInteraction = interacted;
  refresh(target, pathSamples(previous, position));
  if (interacted !== undefined) watcherEvent(target, (w) => w.type === "interaction" && w.path === interacted);
  if (action !== LOCOMOTION_MOVE) watcherEvent(target, (w) => w.type === "action" && w.actions?.includes(action) === true);
  forEachWatcher("action", (_id, w) => (w.actions?.includes(action) ? 1 : 0), target);
}

// Outfit, colour, tube, locomotion state or held item changed.
export function onPlayerStateChanged(session: Session): void {
  const target = targetOf(session);
  if (target) refresh(target);
}

// The player left the room: room watchers lose their switches.
export function onPlayerLeft(session: Session): void {
  switchState.delete(session);
  checkRoomWatchers(session.roomName);
}

// con.use / con.reuse: the consumable's NameOnServer. The client's watcher
// counts only consumables in its list.
export function onConsumableUsed(target: Target, type: string): void {
  watcherEvent(target, (w) => w.type === "consumable" && w.consumables?.includes(type) === true);
  forEachWatcher("consumable", (_id, w) => (w.consumables?.includes(type) ? 1 : 0), target);
}

// wsevent fishing catch: details is the winning reward's name. An empty
// loot list matches every catch.
export function onFishCaught(target: Target, rewardName: string): void {
  forEachWatcher("fish", (_id, w) => (!w.loot?.length || w.loot.includes(rewardName) ? 1 : 0), target);
}

// chat.msg: message text (with emote characters inline) and the sizzle
// clip id sent as "emotion".
export function onChatMessage(target: Target, message: string, sizzleClip: number): void {
  watcherEvent(target, (w) => w.type === "chat" && chatMatches(w, message, sizzleClip) > 0);
  forEachWatcher("chat", (_id, w) => chatMatches(w, message, sizzleClip), target);
}

// ==================== Chat matching ====================
// EmoteTextAndExpressionWatcher.onSendChatMessage.

function isEmote(ch: string): boolean {
  return EMOTE_CODES.has(ch.codePointAt(0)!);
}

// Lowercase, emotes optionally removed, runs of whitespace collapsed, with a
// single space at each end so texts match on word boundaries.
function normalise(str: string, stripEmotes: boolean): string {
  let out = " ";
  let lastWasSpace = true;
  for (const ch of str.toLowerCase()) {
    if (stripEmotes && isEmote(ch)) continue;
    if (/\s/.test(ch)) {
      if (!lastWasSpace) {
        out += " ";
        lastWasSpace = true;
      }
    } else {
      out += ch;
      lastWasSpace = false;
    }
  }
  if (!lastWasSpace) out += " ";
  return out;
}

function occurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  return haystack.split(needle).length - 1;
}

function chatMatches(w: Watcher, message: string, sizzleClip: number): number {
  const emotes = (w.emotes ?? []).map((c) => String.fromCodePoint(c));
  const texts = w.texts ?? [];
  const clips = w.sizzleClips ?? [];
  const hasClip = sizzleClip > 0;
  let num = 0;
  switch (w.matchType) {
    case MATCH_ALL: {
      const stripped = normalise(message, true);
      if (emotes.length + texts.length > 0) num = message.length;
      else if (clips.length > 0) num = 1;
      for (const e of emotes) if (num > 0) num = Math.min(num, occurrences(message, e));
      for (const t of texts) if (num > 0) num = Math.min(num, occurrences(stripped, normalise(t, true)));
      if (hasClip) for (const c of clips) if (num > 0 && c !== sizzleClip) num = 0;
      break;
    }
    case MATCH_ONLY:
      if (emotes.length === 1) {
        if (message.trim() === emotes[0]) num = 1;
      } else if (texts.length === 1) {
        if (normalise(message, false) === normalise(texts[0]!, false)) num = 1;
      }
      if (clips.length === 1) {
        if (texts.length + emotes.length === 0) num = 1;
        if (num === 1) num = hasClip && clips[0] === sizzleClip ? 1 : 0;
      }
      break;
    case MATCH_ANY:
    default: {
      const stripped = normalise(message, true);
      for (const e of emotes) num += occurrences(message, e);
      for (const t of texts) num += occurrences(stripped, normalise(t, true));
      if (hasClip && clips.includes(sizzleClip)) num++;
    }
  }
  if (num === 0 && texts.length === 0 && emotes.length === 0 && clips.length === 0) num = 1;
  if (num > 0 && w.matchCounting === ONE_PER_MESSAGE) num = 1;
  return num;
}
