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
// inside this volume") is on, and switch / room watchers are scene switches
// themselves. Scene switches aren't evaluated yet, so those never fire.
//
// Every task is tracked, not only the day's: the client applies task.c only
// to tasks it has loaded for its content date and ignores the rest.

import data from "../data/daily-tasks.json" with { type: "json" };
import { SFSObjectWriter, encodePacket } from "./sfs-wire.ts";
import { incrementTask } from "./webapi-client.ts";
import { getAll } from "./session-registry.ts";
import type { Session } from "./session.ts";

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
}

interface TaskDef {
  // TaskDefinition.TaskGroup: 0 Individual, 1 Teamwork, 2 Community.
  group: number;
  watchers: Watcher[];
}

interface Target {
  send: (data: Buffer) => void;
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

function taskCountPacket(taskId: string, counter: number): Buffer {
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

// Runs every watcher of one type that can fire without a scene switch.
// count returns how many times the watcher's task is incremented.
function forEachWatcher(type: string, count: (taskId: string, watcher: Watcher) => number, target: Target): void {
  for (const [taskId, def] of Object.entries(TASKS)) {
    for (const watcher of def.watchers) {
      if (watcher.type !== type || watcher.criteriaSwitch) continue;
      const times = count(taskId, watcher);
      if (times > 0) void increment(target, taskId, times);
    }
  }
}

// ==================== Events ====================

// l.a: the locomotion action byte (Jump 1, Interact 2, LaunchThrow 4,
// Torpedo 5, Action1-3 7-9).
export function onLocomotionAction(target: Target, action: number): void {
  forEachWatcher("action", (_id, w) => (w.actions?.includes(action) ? 1 : 0), target);
}

// con.use / con.reuse: the consumable's NameOnServer. The client's watcher
// counts only consumables in its list.
export function onConsumableUsed(target: Target, type: string): void {
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
