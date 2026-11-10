// Scheduled world objects (the Boardwalk geysers). These use SFS2X's MMO
// Items API, not extension commands.
//
// - c=0, a=30 (proximity update): "q" lists items entering the player's
//   area of interest as [itemId, variables, position]. A room with no
//   scheduled objects never gets one.
// - c=0, a=1007 (SetMMOItemVariables): per-item state changes. r = room,
//   i = item id, v = changed variables. Each transition changes only
//   scheduledworldobjectstate and statetimestamp.
// - Item variables are 3-element tuples [name, VariableType byte, value].
//   Unlike user variables there's no isPrivate flag.
//
// The wire format, categories, variable keys and state values come from the
// client. Which rooms have which objects comes from Disney's
// ScheduledWorldObjects server data (data/world-objects.json, world-data.ts),
// by the room's exact zone. A group runs like Disney's OfflineRoomRunner:
// every child starts inactive, one is active at a time, and every
// cycleSeconds the current one goes inactive and the next goes active.
// statetimestamp is the item's last transition, so a late joiner's
// FastForwardStateAction lands at the right point.
//
// State is tracked per room, so several rooms can run at once. A room's
// timers stop when its last player leaves (releaseRoomIfEmpty).

import { SFSObjectWriter, SFSArrayWriter, encodePacket } from "./sfs-wire.ts";
import { getByRoom } from "./session-registry.ts";
import { zoneOfRoom } from "./scene-switches.ts";
import { activePartyNames } from "./parties.ts";
import { contentDateOf, scheduledGroups, type GroupData, type Vec3 } from "./world-data.ts";
import { createPicker } from "./selection.ts";
import type { HandlerContext } from "./handlers/context.ts";

// Client ItemCategory value used for these objects.
const ITEM_CATEGORY_SCHEDULED_ROOM_OBJECT = 2;

// Client ScheduledWorldObjectState values.
const STATE_INACTIVE = 0;
const STATE_ACTIVE = 1;

// Same single room id as login.ts.
const ROOM_ID = 1;

// Multiplies every cycle (tests).
const TIME_SCALE = (() => {
  const v = Number(process.env.WORLD_OBJECTS_TIME_SCALE);
  return Number.isFinite(v) && v > 0 ? v : 1;
})();

export interface LiveItem {
  itemId: number;
  path: string;
  position: Vec3;
  state: number;
  // When state last changed (or the item was created), ms.
  stateChangedMs: number;
}

export interface RoomState {
  items: Map<string, LiveItem>; // path -> item
  timers: Set<NodeJS.Timeout>;
}

const rooms = new Map<string, RoomState>();
let nextItemId = 1;

// MMO item ids share one counter with consumables (handlers/consumables.ts),
// since they live in the same room item list on the client.
export function allocateItemId(): number {
  return nextItemId++;
}

// ==================== Wire encoding ====================

// [name, type, value] - no isPrivate flag on item variables.
function itemIntVar(name: string, value: number): SFSArrayWriter {
  return new SFSArrayWriter().putUtfString(name).putVariableType("int").putInt(value);
}
function itemStringVar(name: string, value: string): SFSArrayWriter {
  return new SFSArrayWriter().putUtfString(name).putVariableType("string").putUtfString(value);
}

// Variables the client's StatefulWorldObject reads.
function encodeItemVariables(item: LiveItem): SFSArrayWriter {
  return new SFSArrayWriter()
    .putSFSArray(itemIntVar("category", ITEM_CATEGORY_SCHEDULED_ROOM_OBJECT))
    .putSFSArray(itemIntVar("creator", 0))
    .putSFSArray(itemStringVar("path", item.path))
    .putSFSArray(itemStringVar("statetimestamp", String(item.stateChangedMs)))
    .putSFSArray(itemIntVar("scheduledworldobjectstate", item.state));
}

// MMOItem wire shape: [itemId, variables, position].
function encodeItemTuple(item: LiveItem): SFSArrayWriter {
  return new SFSArrayWriter().putInt(item.itemId).putSFSArray(encodeItemVariables(item)).putFloatArray(item.position);
}

// Sends a joining player every object in the room (c=0, a=30).
export function sendWorldObjectsSnapshot(ctx: HandlerContext, roomName: string): void {
  const state = ensureRoomWorldObjects(roomName);
  if (state.items.size === 0) return;
  const q = new SFSArrayWriter();
  for (const item of state.items.values()) q.putSFSArray(encodeItemTuple(item));
  const params = new SFSObjectWriter().putInt("r", ROOM_ID).putSFSArray("q", q);
  ctx.send(encodePacket(0, 30, params));
  console.log(
    `[${new Date().toISOString()}] ${ctx.peer} <- world objects snapshot (room=${roomName}, items=${state.items.size})`
  );
}

// Changes an item's state and tells the whole room (c=0, a=1007).
function setItemState(roomName: string, item: LiveItem, state: number): void {
  item.state = state;
  item.stateChangedMs = Date.now();
  const varList = new SFSArrayWriter()
    .putSFSArray(itemIntVar("scheduledworldobjectstate", item.state))
    .putSFSArray(itemStringVar("statetimestamp", String(item.stateChangedMs)));
  const params = new SFSObjectWriter().putInt("r", ROOM_ID).putInt("i", item.itemId).putSFSArray("v", varList);
  const packet = encodePacket(0, 1007, params);
  const targets = getByRoom(roomName);
  for (const { send } of targets) send(packet);
  console.log(
    `[${new Date().toISOString()}] world object state change (room=${roomName}, path=${item.path}, state=${
      item.state === STATE_ACTIVE ? "ACTIVE" : "INACTIVE"
    }, recipients=${targets.length})`
  );
}

// ==================== Scheduling ====================

function startGroup(roomName: string, state: RoomState, group: GroupData): void {
  if (group.children.length === 0) return;
  const now = Date.now();
  const children: LiveItem[] = group.children.map((child) => {
    const item: LiveItem = { itemId: allocateItemId(), path: child.path, position: child.position, state: STATE_INACTIVE, stateChangedMs: now };
    state.items.set(child.path, item);
    return item;
  });
  const pick = createPicker(group.behaviour, children.length);
  let current: LiveItem | undefined;
  let timer: NodeJS.Timeout | undefined;
  const cycle = () => {
    if (timer) state.timers.delete(timer);
    if (current) setItemState(roomName, current, STATE_INACTIVE);
    current = children[pick()]!;
    setItemState(roomName, current, STATE_ACTIVE);
    timer = setTimeout(cycle, group.cycleSeconds * 1000 * TIME_SCALE);
    state.timers.add(timer);
  };
  cycle();
}

// Stops a room's timers and forgets its objects once nobody is in it.
// Rooms are per world, language, zone, client version and day, so without
// this every room ever visited kept its timers running forever. The next
// player to join gets fresh objects; clients sync from statetimestamp.
export function releaseRoomIfEmpty(roomName: string): void {
  const state = rooms.get(roomName);
  if (!state || getByRoom(roomName).length > 0) return;
  for (const timer of state.timers) clearTimeout(timer);
  rooms.delete(roomName);
  if (state.items.size > 0) {
    console.log(`[${new Date().toISOString()}] world objects released for empty room "${roomName}"`);
  }
}

// Live room and timer counts, for tests and diagnostics.
export function worldObjectStats(): { rooms: number; timers: number } {
  let timers = 0;
  for (const state of rooms.values()) timers += state.timers.size;
  return { rooms: rooms.size, timers };
}

// Creates a room's objects and timers once, when the first player joins.
export function ensureRoomWorldObjects(roomName: string): RoomState {
  const existing = rooms.get(roomName);
  if (existing) return existing;
  const state: RoomState = { items: new Map(), timers: new Set() };
  rooms.set(roomName, state);
  for (const group of scheduledGroups(zoneOfRoom(roomName), contentDateOf(roomName), activePartyNames())) startGroup(roomName, state, group);
  if (state.items.size > 0) {
    console.log(`[${new Date().toISOString()}] world objects initialized for room "${roomName}" (${state.items.size} items)`);
  }
  return state;
}
