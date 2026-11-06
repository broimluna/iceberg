// Scheduled World Objects (geysers, blinking lights, air vents, etc.) -
// SFS2X's built-in MMO Room Items API, NOT a CallExtension command. This is
// the mechanism traced from a real byte-level capture against actual
// retail SFS2X running a `cpi` extension:
//
// - `c=0,a=30` ("Action 30") is SFS2X's own proximity-list-update push,
//   reusing the same wire shape as the client's outgoing SetUserPositionRequest
//   (SmartFox2X.decompiled.cs:3396 FnSetUserPosition, confirmed against
//   SetUserPositionRequest's own KEY_ROOM="r"/KEY_PLUS_ITEM_LIST="q" wire
//   keys). It fires whenever an MMO item enters a user's area of interest -
//   in the real capture this happened ~450ms after JoinRoom, tied to
//   Alpine:Town's two blinking lights being created (`setMMOItemPosition`
//   is itself what triggers "item entered AOI"), never synchronously as
//   part of login. A room with zero scheduled objects gets zero action-30
//   packets, ever.
// - `c=0,a=1007` (`SetMMOItemVariables`, SmartFox2X.decompiled.cs:3479/13980)
//   is the incremental per-item update used for every state change after
//   creation - `r`=room id, `i`=item id, `v`=SFSArray of changed variable
//   tuples. Matches Java's `ScheduledWorldObjectManager.setObjectState`/
//   `performStateTransition`, which only ever touch two variables per
//   transition (`scheduledworldobjectstate`, `statetimestamp`).
// - Item variable tuples are `[name:string, declaredType:byte, value]`,
//   THREE elements - confirmed via `MMOItemVariable.FromSFSArray`
//   (SmartFox2X.decompiled.cs:9355: `GetUtfString(0)`, `GetByte(1)`,
//   `GetElementAt(2)`). No trailing "isPrivate" bool - that's a
//   `RoomVariable`-only field (`SFSUserVariable`/`SFSRoomVariable`), and
//   `MMOItemVariable` only implements the plain `Variable` interface. The
//   declared-type byte is the same `VariableType` enum (INT=2/STRING=4)
//   `handlers/sfs2x/login.ts`'s `intVar`/`stringVar` already use for user
//   variables, not the wire-level `SFSDataType` byte (that's a separate,
//   self-describing prefix already baked into the value at index 2).
// - Item categories/variable keys/state enum are all decompiled-confirmed
//   client-side (`ClubPenguin.Net.Client.Smartfox.Item.ItemCategory`,
//   `SocketItemVars` w/ `[SocketItemVars(key, type)]` attributes,
//   `ScheduledWorldObjectState`, `StatefulWorldObject`'s constructor -
//   ClubPenguinClient.decompiled.cs:7813-9874) and match a working Java
//   SFS2X extension's constants byte-for-byte.
//
// What's NOT decompiled-confirmed: WHICH rooms have WHICH objects at what
// positions/timings. That part is carried over from the recovered Java
// extension's own `ScheduledWorldObjectManager.createDefaultObjectsForRoom`
// (my.test.world.ScheduledWorldObjectManager.java) - real, CDN-sourced data
// for Beacon Boardwalk/AquaFunHut's 8 geyser locations (that file's own
// comment cites `OpenCPI-CDN/.../ServerData/b9ead7...json`, not
// independently re-verified here - the CDN dump isn't part of this repo),
// best-guess placeholder positions/
// timings for everything else (Mt. Blizzard geysers, underwater air vents,
// town lights - marked as such in the Java source's own comments, not
// presented as more certain than that here either). Room-name matching is
// substring-based exactly like the Java version (`roomName.includes(...)`),
// which is also how "Alpine:Town" - the one room this project has an actual
// real capture for (two blinking lights) - falls under the "Town" case
// below without needing its own special-cased entry.
//
// Deliberately NOT a singleton the way the recovered Java's
// `ScheduledWorldObjectManager.getInstance()` was (a real limitation in
// that old code: `init()` no-ops for every room after the first one ever
// seen, server-process-wide). This server supports multiple concurrent
// rooms, so it's a real per-room registry instead - a fidelity improvement
// over the old code's bug, not a wire-protocol change.

import { SFSObjectWriter, SFSArrayWriter, encodePacket } from "./sfs-wire.ts";
import { getByRoom } from "./session-registry.ts";
import type { HandlerContext } from "./handlers/context.ts";

// ClubPenguin.Net.Client.Smartfox.Item.ItemCategory (ClubPenguinClient.
// decompiled.cs:8030) - only the one category this module produces.
const ITEM_CATEGORY_SCHEDULED_ROOM_OBJECT = 2;

// ScheduledWorldObjectState (ClubPenguinClient.decompiled.cs:9848).
const STATE_INACTIVE = 0;
const STATE_ACTIVE = 1;

// Sfs2X.Entities.Variables.VariableType (NULL=0/BOOL=1/INT=2/DOUBLE=3/
// STRING=4/OBJECT=5/ARRAY=6) - same enum handlers/sfs2x/login.ts's
// intVar/stringVar use, see this file's header comment.
const VARIABLE_TYPE_INT = 2;
const VARIABLE_TYPE_STRING = 4;

// This server always sends room id=1 for whatever room a session is in
// (handlers/sfs2x/login.ts's buildRoomArray hardcodes it too) - single
// numeric room id, not one per distinct room name.
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

// ==================== Room -> default object defs ====================
// Ported from a Java SFS2X extension's ScheduledWorldObjectManager
// createDefaultObjectsForRoom - see this
// file's header comment for what's real vs. best-guess.

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
    // Matches "Alpine:Town" - the one room this project has a real capture
    // for (two blinking lights). Exact real
    // paths/positions weren't captured in writable form, only the count and
    // wire shape - names/positions below are the recovered Java's own
    // placeholders, not decompiled fact.
    defs.push({ path: "TownLight1", position: [5, 3, 0], activeSeconds: 2, inactiveSeconds: 2, startActive: true });
    defs.push({ path: "TownLight2", position: [-5, 3, 0], activeSeconds: 2, inactiveSeconds: 2, startActive: false });
  }
  return defs;
}

function groupDefsForRoom(roomName: string): GroupDef[] {
  const groups: GroupDef[] = [];
  if (roomName.includes("Boardwalk") || roomName.includes("AquaFunHut")) {
    // Real CDN-sourced positions per the recovered Java source's own
    // comment (OpenCPI-CDN ServerData - not independently re-verified in
    // this repo, see this file's header). cycleTimeSeconds=17,
    // NonRepeatingRandom selection, activeDuration=30s (20s attract + 10s
    // eruption per the client's own animation timing).
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

// Item variable tuple - see this file's header comment for why this is a
// 3-element array (no trailing isPrivate bool, unlike user/room variables).
function itemIntVar(name: string, value: number): SFSArrayWriter {
  return new SFSArrayWriter().putUtfString(name).putByte(VARIABLE_TYPE_INT).putInt(value);
}
function itemStringVar(name: string, value: string): SFSArrayWriter {
  return new SFSArrayWriter().putUtfString(name).putByte(VARIABLE_TYPE_STRING).putUtfString(value);
}

// Full variable set a StatefulWorldObject needs (ClubPenguinClient.
// decompiled.cs:9868's constructor reads path/statetimestamp/
// scheduledworldobjectstate; category/creator are read generically by
// ItemFactory.Create for every category).
function encodeItemVariables(item: LiveItem): SFSArrayWriter {
  return new SFSArrayWriter()
    .putSFSArray(itemIntVar("category", ITEM_CATEGORY_SCHEDULED_ROOM_OBJECT))
    .putSFSArray(itemIntVar("creator", 0))
    .putSFSArray(itemStringVar("path", item.path))
    .putSFSArray(itemStringVar("statetimestamp", String(Date.now())))
    .putSFSArray(itemIntVar("scheduledworldobjectstate", item.state));
}

// [itemId:int, variables:SFSArray, position:FloatArray] - MMOItem.
// FromSFSArray's exact tuple shape (SmartFox2X.decompiled.cs:5487).
function encodeItemTuple(item: LiveItem): SFSArrayWriter {
  return new SFSArrayWriter().putInt(item.itemId).putSFSArray(encodeItemVariables(item)).putFloatArray(item.position);
}

// c=0,a=30 - full items-in-AOI snapshot, sent once per session (their own
// "an item just entered my AOI" event) rather than broadcast, since every
// other session in the room already got their own snapshot at their own
// join time.
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

// c=0,a=1007 (SetMMOItemVariables) - broadcast to every session currently
// registered in the room, since a state change is visible to everyone, not
// just whoever triggered it (nobody triggers it - it's timer-driven).
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
    itemId: nextItemId++,
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
      itemId: nextItemId++,
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

// Idempotent per room name - real objects/timers are created exactly once,
// on whichever session joins that room first.
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
