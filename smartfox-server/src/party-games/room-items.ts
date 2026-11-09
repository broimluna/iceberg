// Room MMO items for party games: the lobby and the game state that every
// player in the room sees (the client's PartygameLobbyMmoItem and
// DanceBattleMmoItem). Same wire as world-objects.ts and consumables.ts:
//   c=0 a=30   "q" adds items [itemId, variables, position]; "n" removes ids
//   c=0 a=1007 one item's changed variables (r room, i item, v variables)
// Item variables are [name, VariableType, value] with no isPrivate flag.
import { SFSObjectWriter, SFSArrayWriter, encodePacket } from "../sfs-wire.ts";
import { getByRoom } from "../session-registry.ts";
import { allocateItemId } from "../world-objects.ts";
import type { HandlerContext } from "../handlers/context.ts";

// Client ItemCategory (ClubPenguinClient ItemFactory.Create): 6 builds a
// PartygameLobbyMmoItem, 7 a DanceBattleMmoItem. Neither reads "template".
export const ITEM_CATEGORY_PARTY_GAME_LOBBY = 6;
export const ITEM_CATEGORY_DANCE_BATTLE = 7;

// Same single room id as login.ts and world-objects.ts.
const ROOM_ID = 1;

export type ItemVar = { type: "int" | "double" | "string"; value: number | string };

export interface RoomItem {
  itemId: number;
  roomName: string;
  position: [number, number, number];
  vars: Map<string, ItemVar>;
}

const items = new Map<number, RoomItem>();

function encodeVar(name: string, v: ItemVar): SFSArrayWriter {
  const w = new SFSArrayWriter().putUtfString(name).putVariableType(v.type);
  if (v.type === "int") return w.putInt(v.value as number);
  if (v.type === "double") return w.putDouble(v.value as number);
  return w.putUtfString(v.value as string);
}

function encodeTuple(item: RoomItem): SFSArrayWriter {
  const vars = new SFSArrayWriter();
  for (const [name, v] of item.vars) vars.putSFSArray(encodeVar(name, v));
  return new SFSArrayWriter().putInt(item.itemId).putSFSArray(vars).putFloatArray(item.position);
}

function sendToRoom(roomName: string, packet: ReturnType<typeof encodePacket>): void {
  for (const entry of getByRoom(roomName)) entry.send(packet);
}

export function addRoomItem(roomName: string, position: [number, number, number], vars: Record<string, ItemVar>): RoomItem {
  const item: RoomItem = { itemId: allocateItemId(), roomName, position, vars: new Map(Object.entries(vars)) };
  items.set(item.itemId, item);
  const q = new SFSArrayWriter().putSFSArray(encodeTuple(item));
  sendToRoom(roomName, encodePacket(0, 30, new SFSObjectWriter().putInt("r", ROOM_ID).putSFSArray("q", q)));
  return item;
}

export function setRoomItemVar(item: RoomItem, name: string, v: ItemVar): void {
  if (!items.has(item.itemId)) return;
  item.vars.set(name, v);
  const params = new SFSObjectWriter().putInt("r", ROOM_ID).putInt("i", item.itemId).putSFSArray("v", new SFSArrayWriter().putSFSArray(encodeVar(name, v)));
  sendToRoom(item.roomName, encodePacket(0, 1007, params));
}

export function removeRoomItem(item: RoomItem): void {
  if (!items.delete(item.itemId)) return;
  sendToRoom(item.roomName, encodePacket(0, 30, new SFSObjectWriter().putInt("r", ROOM_ID).putIntArray("n", [item.itemId])));
}

export function roomItemsIn(roomName: string): RoomItem[] {
  return [...items.values()].filter((i) => i.roomName === roomName);
}

// Sends a joining player the party-game items live in the room (c=0, a=30).
export function sendRoomItemsSnapshot(ctx: HandlerContext, roomName: string): void {
  const live = roomItemsIn(roomName);
  if (live.length === 0) return;
  const q = new SFSArrayWriter();
  for (const item of live) q.putSFSArray(encodeTuple(item));
  ctx.send(encodePacket(0, 30, new SFSObjectWriter().putInt("r", ROOM_ID).putSFSArray("q", q)));
}
