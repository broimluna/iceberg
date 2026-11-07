// Scheduled world objects: geysers, blinking lights, air vents. These use
// SFS2X's MMO Items API, not extension commands.
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
// client. Which rooms have which objects, and where, comes from a Java SFS2X
// extension's ScheduledWorldObjectManager: the Beacon Boardwalk geyser
// positions are from game data, the rest are placeholders. Rooms are
// matched by substring, so "Alpine:Town" falls under "Town".
//
// State is tracked per room, so several rooms can run at once.

import { SFSObjectWriter, SFSArrayWriter, encodePacket } from "./sfs-wire.ts";
import { getByRoom } from "./session-registry.ts";
import type { HandlerContext } from "./handlers/context.ts";

// Client ItemCategory value used for these objects.
const ITEM_CATEGORY_SCHEDULED_ROOM_OBJECT = 2;

// Client ScheduledWorldObjectState values.
const STATE_INACTIVE = 0;
const STATE_ACTIVE = 1;

// SFS2X VariableType: NULL=0, BOOL=1, INT=2, DOUBLE=3, STRING=4, OBJECT=5, ARRAY=6.
const VARIABLE_TYPE_INT = 2;
const VARIABLE_TYPE_STRING = 4;

// Same single room id as login.ts.
const ROOM_ID = 1;

type SelectionBehaviour = "ordered" | "random" | "nonRepeatingRandom";

interface WorldObjectDef {
  path: string;
  position: [number, number, number];
  activeSeconds: number;
  inactiveSeconds: number;
  startActive: boolean;
}

interface GroupMemberDef {
  path: string;
  position: [number, number, number];
  activeDurationSeconds: number;
}

interface GroupDef {
  groupId: string;
  cycleTimeSeconds: number;
  selectionBehaviour: SelectionBehaviour;
  members: GroupMemberDef[];
}

interface LiveItem {
  itemId: number;
  path: string;
  position: [number, number, number];
  state: number;
  activeSeconds: number;
  inactiveSeconds: number;
}

interface RoomState {
  items: Map<string, LiveItem>; // path -> item
  timers: Set<NodeJS.Timeout>;
  groupActive: Map<string, string>; // groupId -> currently-active path
}

const rooms = new Map<string, RoomState>();
let nextItemId = 1;

// MMO item ids share one counter with consumables (handlers/consumables.ts),
// since they live in the same room item list on the client.
export function allocateItemId(): number {
  return nextItemId++;
}

// ==================== Room -> default object defs ====================

function individualDefsForRoom(roomName: string): WorldObjectDef[] {
  const defs: WorldObjectDef[] = [];
  if (roomName.includes("MtBlizzard") || roomName.includes("Mountain")) {
    // Best-guess placeholder positions/timings, not CDN-sourced.
    defs.push({ path: "Geyser1", position: [-10, 0, 15], activeSeconds: 5, inactiveSeconds: 10, startActive: true });
    defs.push({ path: "Geyser2", position: [5, 0, 20], activeSeconds: 5, inactiveSeconds: 15, startActive: true });
    defs.push({ path: "Geyser3", position: [12, 0, 12], activeSeconds: 5, inactiveSeconds: 8, startActive: true });
  }
  if (roomName.includes("Underwater") || roomName.includes("Diving")) {
    defs.push({ path: "AirVent1", position: [0, -5, 0], activeSeconds: 3, inactiveSeconds: 7, startActive: true });
    defs.push({ path: "AirVent2", position: [10, -8, 5], activeSeconds: 3, inactiveSeconds: 10, startActive: true });
    defs.push({ path: "AirVent3", position: [-8, -6, -5], activeSeconds: 3, inactiveSeconds: 5, startActive: true });
  }
  if (roomName.includes("Town")) {
    // Placeholder names and positions. A real capture shows two blinking lights here.
    defs.push({ path: "TownLight1", position: [5, 3, 0], activeSeconds: 2, inactiveSeconds: 2, startActive: true });
    defs.push({ path: "TownLight2", position: [-5, 3, 0], activeSeconds: 2, inactiveSeconds: 2, startActive: false });
  }
  return defs;
}

function groupDefsForRoom(roomName: string): GroupDef[] {
  const groups: GroupDef[] = [];
  if (roomName.includes("Boardwalk") || roomName.includes("AquaFunHut")) {
    // Positions from game data. 17s cycle, random non-repeating pick, active
    // for 30s (20s build-up + 10s eruption).
    groups.push({
      groupId: "AquaFunHutGeysers",
      cycleTimeSeconds: 17,
      selectionBehaviour: "nonRepeatingRandom",
      members: [
        { path: "/Minigames/AquaFunHut/GeyserLocations/GeyserLocation01", position: [8.4, -1.54, 24.24], activeDurationSeconds: 30 },
        { path: "/Minigames/AquaFunHut/GeyserLocations/GeyserLocation02", position: [10.43, -1.54, 21.68], activeDurationSeconds: 30 },
        { path: "/Minigames/AquaFunHut/GeyserLocations/GeyserLocation03", position: [11.89, -1.54, 18.51], activeDurationSeconds: 30 },
        { path: "/Minigames/AquaFunHut/GeyserLocations/GeyserLocation04", position: [2.45, -1.54, 20.1], activeDurationSeconds: 30 },
        { path: "/Minigames/AquaFunHut/GeyserLocations/GeyserLocation05", position: [0.63, -1.54, 24.74], activeDurationSeconds: 30 },
        { path: "/Minigames/AquaFunHut/GeyserLocations/GeyserLocation06", position: [3.86, -1.54, 26.87], activeDurationSeconds: 30 },
        { path: "/Minigames/AquaFunHut/GeyserLocations/GeyserLocation07", position: [13.44, -1.54, 20.11], activeDurationSeconds: 30 },
        { path: "/Minigames/AquaFunHut/GeyserLocations/GeyserLocation08", position: [8.06, -1.54, 20.37], activeDurationSeconds: 30 },
      ],
    });
  }
  return groups;
}

// ==================== Wire encoding ====================

// [name, type, value] - no isPrivate flag on item variables.
function itemIntVar(name: string, value: number): SFSArrayWriter {
  return new SFSArrayWriter().putUtfString(name).putByte(VARIABLE_TYPE_INT).putInt(value);
}
function itemStringVar(name: string, value: string): SFSArrayWriter {
  return new SFSArrayWriter().putUtfString(name).putByte(VARIABLE_TYPE_STRING).putUtfString(value);
}

// Variables the client's StatefulWorldObject reads.
function encodeItemVariables(item: LiveItem): SFSArrayWriter {
  return new SFSArrayWriter()
    .putSFSArray(itemIntVar("category", ITEM_CATEGORY_SCHEDULED_ROOM_OBJECT))
    .putSFSArray(itemIntVar("creator", 0))
    .putSFSArray(itemStringVar("path", item.path))
    .putSFSArray(itemStringVar("statetimestamp", String(Date.now())))
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

// Broadcasts a timer-driven state change to the whole room (c=0, a=1007).
function broadcastItemStateChange(roomName: string, item: LiveItem): void {
  const varList = new SFSArrayWriter()
    .putSFSArray(itemIntVar("scheduledworldobjectstate", item.state))
    .putSFSArray(itemStringVar("statetimestamp", String(Date.now())));
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

function scheduleIndividualTransition(roomName: string, state: RoomState, item: LiveItem, delaySeconds: number): void {
  const timer = setTimeout(() => {
    item.state = item.state === STATE_ACTIVE ? STATE_INACTIVE : STATE_ACTIVE;
    broadcastItemStateChange(roomName, item);
    scheduleIndividualTransition(roomName, state, item, item.state === STATE_ACTIVE ? item.activeSeconds : item.inactiveSeconds);
  }, delaySeconds * 1000);
  state.timers.add(timer);
}

function createIndividualObject(roomName: string, state: RoomState, def: WorldObjectDef): void {
  const item: LiveItem = {
    itemId: allocateItemId(),
    path: def.path,
    position: def.position,
    state: def.startActive ? STATE_ACTIVE : STATE_INACTIVE,
    activeSeconds: def.activeSeconds,
    inactiveSeconds: def.inactiveSeconds,
  };
  state.items.set(def.path, item);
  scheduleIndividualTransition(roomName, state, item, def.startActive ? def.activeSeconds : def.inactiveSeconds);
}

function pickNext(group: GroupDef, order: LiveItem[], shuffled: LiveItem[], indexRef: { i: number }): LiveItem {
  switch (group.selectionBehaviour) {
    case "ordered":
      indexRef.i = (indexRef.i + 1) % order.length;
      return order[indexRef.i]!;
    case "random":
      return order[Math.floor(Math.random() * order.length)]!;
    case "nonRepeatingRandom":
    default:
      indexRef.i++;
      if (indexRef.i >= shuffled.length) {
        shuffled.splice(0, shuffled.length, ...shuffle(order));
        indexRef.i = 0;
      }
      return shuffled[indexRef.i]!;
  }
}

function shuffle<T>(arr: T[]): T[] {
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j]!, copy[i]!];
  }
  return copy;
}

function createGroup(roomName: string, state: RoomState, group: GroupDef): void {
  const order: LiveItem[] = group.members.map((member) => {
    const item: LiveItem = {
      itemId: allocateItemId(),
      path: member.path,
      position: member.position,
      state: STATE_INACTIVE,
      activeSeconds: member.activeDurationSeconds,
      inactiveSeconds: 0,
    };
    state.items.set(member.path, item);
    return item;
  });
  let shuffled = group.selectionBehaviour === "nonRepeatingRandom" ? shuffle(order) : order;
  const indexRef = { i: -1 };

  const cycleNext = () => {
    const currentPath = state.groupActive.get(group.groupId);
    if (currentPath) {
      const current = state.items.get(currentPath);
      if (current) {
        current.state = STATE_INACTIVE;
        broadcastItemStateChange(roomName, current);
      }
    }
    const next = pickNext(group, order, shuffled, indexRef);
    next.state = STATE_ACTIVE;
    state.groupActive.set(group.groupId, next.path);
    broadcastItemStateChange(roomName, next);
    const durationSeconds = next.activeSeconds > 0 ? next.activeSeconds : group.cycleTimeSeconds;
    const timer = setTimeout(cycleNext, durationSeconds * 1000);
    state.timers.add(timer);
  };
  cycleNext();
}

// Creates a room's objects and timers once, when the first player joins.
export function ensureRoomWorldObjects(roomName: string): RoomState {
  const existing = rooms.get(roomName);
  if (existing) return existing;
  const state: RoomState = { items: new Map(), timers: new Set(), groupActive: new Map() };
  rooms.set(roomName, state);
  for (const def of individualDefsForRoom(roomName)) createIndividualObject(roomName, state, def);
  for (const group of groupDefsForRoom(roomName)) createGroup(roomName, state, group);
  if (state.items.size > 0) {
    console.log(`[${new Date().toISOString()}] world objects initialized for room "${roomName}" (${state.items.size} items)`);
  }
  return state;
}
