import { SFSObjectWriter, SFSArrayWriter, encodePacket, type SFSObjectData } from "../sfs-wire.ts";
import { getUtfString } from "../wire-helpers.ts";
import { getByRoom, getByRoomExcluding, type RegisteredSession } from "../session-registry.ts";
import type { Session } from "../session.ts";
import { allocateItemId } from "../world-objects.ts";
import { CONSUMABLES, type ConsumableDef } from "../consumable-catalog.ts";
import type { HandlerContext } from "./context.ts";

// Client ItemCategory.Consumable and ConsumableItemTemplate values.
const ITEM_CATEGORY_CONSUMABLE = 1;
const TEMPLATE_TIMED = "timed";
const TEMPLATE_ACTIONED = "actioned";

// SFS2X VariableType.
const VARIABLE_TYPE_NULL = 0;
const VARIABLE_TYPE_INT = 2;
const VARIABLE_TYPE_DOUBLE = 3;
const VARIABLE_TYPE_STRING = 4;

// RewardSource.WORLD_OBJECT.
const REWARD_SOURCE_WORLD_OBJECT = 1;

// Client ObjectType.SERVER / PLAYER and LocomotionAction.Interact.
const OBJECT_TYPE_SERVER = 1;
const OBJECT_TYPE_PLAYER = 2;
const LOCOMOTION_ACTION_INTERACT = 2;

// Same single room id as login.ts.
const ROOM_ID = 1;

interface LiveConsumable {
  itemId: number;
  roomName: string;
  type: string;
  creatorUserId: number;
  position: [number, number, number];
  def: ConsumableDef;
  timeToLive: number;
  // Set only for the "actioned" template.
  actionCount: number | undefined;
}

const liveItems = new Map<number, LiveConsumable>();

function log(msg: string): void {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

function extensionPacket(cmd: string, p: SFSObjectWriter): Buffer {
  return encodePacket(1, 13, new SFSObjectWriter().putUtfString("c", cmd).putSFSObject("p", p));
}

function sendToRoom(roomName: string, packet: Buffer): RegisteredSession[] {
  const targets = getByRoom(roomName);
  for (const { send } of targets) send(packet);
  return targets;
}

// "prop" is the JSON-serialized properties object; for world consumables
// it's the Vector3 drop point. Falls back to the player's last position.
function parsePosition(propJson: string | undefined, ctx: HandlerContext): [number, number, number] {
  if (propJson) {
    try {
      const prop = JSON.parse(propJson);
      const xyz = [prop?.x ?? prop?.X, prop?.y ?? prop?.Y, prop?.z ?? prop?.Z].map(Number);
      if (xyz.every(Number.isFinite)) return xyz as [number, number, number];
    } catch {
      // Not JSON; use the fallback.
    }
  }
  const last = ctx.session.lastPosition;
  return [last?.[0] ?? 0, last?.[1] ?? 0, last?.[2] ?? 0];
}

// Clears the user's "con" variable (VariableType NULL deletes it), which
// the client reads as HELD_OBJECT_DEQUIPPED. Sent to the whole room,
// sender included, like any SetUserVariables broadcast.
function broadcastDequip(ctx: HandlerContext): void {
  const conEntry = new SFSArrayWriter().putUtfString("con").putByte(VARIABLE_TYPE_NULL).putNull().putBool(false);
  const params = new SFSObjectWriter().putInt("u", ctx.session.userId).putSFSArray("vl", new SFSArrayWriter().putSFSArray(conEntry));
  sendToRoom(ctx.session.roomName, encodePacket(0, 12, params));
  ctx.session.equippedItemName = undefined;
  ctx.session.equippedConsumable = undefined;
  ctx.session.heldActionCount = undefined;
}

// ==================== MMO item encoding ====================

function intVar(name: string, value: number): SFSArrayWriter {
  return new SFSArrayWriter().putUtfString(name).putByte(VARIABLE_TYPE_INT).putInt(value);
}
function doubleVar(name: string, value: number): SFSArrayWriter {
  return new SFSArrayWriter().putUtfString(name).putByte(VARIABLE_TYPE_DOUBLE).putDouble(value);
}
function stringVar(name: string, value: string): SFSArrayWriter {
  return new SFSArrayWriter().putUtfString(name).putByte(VARIABLE_TYPE_STRING).putUtfString(value);
}

// Variables read by the client's ItemFactory, TimedItem and ActionedItem.
// MMOItem wire shape: [itemId, variables, position].
function encodeItemTuple(item: LiveConsumable): SFSArrayWriter {
  const vars = new SFSArrayWriter()
    .putSFSArray(intVar("category", ITEM_CATEGORY_CONSUMABLE))
    .putSFSArray(stringVar("template", item.actionCount !== undefined ? TEMPLATE_ACTIONED : TEMPLATE_TIMED))
    .putSFSArray(intVar("creator", item.creatorUserId))
    .putSFSArray(stringVar("type", item.type))
    .putSFSArray(doubleVar("ttl", item.timeToLive));
  if (item.actionCount !== undefined) vars.putSFSArray(intVar("actioncount", item.actionCount));
  return new SFSArrayWriter().putInt(item.itemId).putSFSArray(vars).putFloatArray(item.position);
}

// Proximity update (c=0, a=30): "q" adds items, "n" removes item ids.
function broadcastItemAdded(item: LiveConsumable): void {
  const q = new SFSArrayWriter().putSFSArray(encodeItemTuple(item));
  sendToRoom(item.roomName, encodePacket(0, 30, new SFSObjectWriter().putInt("r", ROOM_ID).putSFSArray("q", q)));
}

function broadcastItemRemoved(item: LiveConsumable): void {
  sendToRoom(item.roomName, encodePacket(0, 30, new SFSObjectWriter().putInt("r", ROOM_ID).putIntArray("n", [item.itemId])));
}

// SetMMOItemVariables (c=0, a=1007) with only the changed variable.
function broadcastItemVariable(item: LiveConsumable, variable: SFSArrayWriter): void {
  const params = new SFSObjectWriter().putInt("r", ROOM_ID).putInt("i", item.itemId).putSFSArray("v", new SFSArrayWriter().putSFSArray(variable));
  sendToRoom(item.roomName, encodePacket(0, 1007, params));
}

// Sends a joining player the consumables currently live in the room.
export function sendConsumableItemsSnapshot(ctx: HandlerContext, roomName: string): void {
  const items = [...liveItems.values()].filter((item) => item.roomName === roomName);
  if (items.length === 0) return;
  const q = new SFSArrayWriter();
  for (const item of items) q.putSFSArray(encodeItemTuple(item));
  ctx.send(encodePacket(0, 30, new SFSObjectWriter().putInt("r", ROOM_ID).putSFSArray("q", q)));
}

// ==================== Rewards ====================

function distance(a: number[], b: number[]): number {
  return Math.hypot((a[0] ?? 0) - (b[0] ?? 0), (a[1] ?? 0) - (b[1] ?? 0), (a[2] ?? 0) - (b[2] ?? 0));
}

// When a world consumable expires, players within RewardRadius of it (by
// last reported position) split TotalReward, each getting at least
// MinPerPlayerReward. The creator always counts as a recipient. Each player
// gets "reward.add" with only their own entry; the client then persists it
// through PUT /reward/v1, which applies every entry it's given.
function sendExpiryRewards(item: LiveConsumable): void {
  const { totalCoins = 0, minCoins = 0, rewardRadius = 0 } = item.def;
  if (totalCoins <= 0) return;
  const recipients = getByRoom(item.roomName).filter(
    ({ session }) =>
      session.userId === item.creatorUserId ||
      (session.lastPosition !== undefined && distance(session.lastPosition, item.position) <= rewardRadius)
  );
  if (recipients.length === 0) return;
  const coins = Math.max(minCoins, Math.floor(totalCoins / recipients.length));
  for (const { session, send, peer } of recipients) {
    if (!session.playerSessionId) continue;
    const payload = {
      goodUntil: 0,
      signature: "",
      swid: "",
      data: {
        source: REWARD_SOURCE_WORLD_OBJECT,
        sourceId: String(item.itemId),
        rewards: { [session.playerSessionId]: { coins } },
      },
    };
    send(extensionPacket("reward.add", new SFSObjectWriter().putUtfString("reward", JSON.stringify(payload))));
    log(`${peer} <- reward.add (${item.type} #${item.itemId}, coins=${coins})`);
  }
}

// ==================== Lifecycle ====================

// Counts ttl down once a second, broadcasting each new value. At zero the
// rewards go out and the item is removed.
function tick(item: LiveConsumable): void {
  item.timeToLive -= 1;
  if (item.timeToLive > 0) {
    broadcastItemVariable(item, doubleVar("ttl", item.timeToLive));
    setTimeout(() => tick(item), 1000);
    return;
  }
  liveItems.delete(item.itemId);
  sendExpiryRewards(item);
  broadcastItemRemoved(item);
  log(`consumable item #${item.itemId} (${item.type}) expired in ${item.roomName}`);
}

// World consumables (party blasters, pinatas). The order matches the
// client's offline game server: con.mmoitemdeployed first, so the
// creator's PropUser records the pending item id and doesn't store the
// prop on dequip; then the dequip; then the item. Every client, the
// creator included, plays the prop when the item and its position arrive.
function deployWorldConsumable(ctx: HandlerContext, type: string, def: ConsumableDef, partialCount: number, propJson: string | undefined): void {
  const { session } = ctx;
  const actioned = (def.actionCount ?? 0) > 0;
  const item: LiveConsumable = {
    itemId: allocateItemId(),
    roomName: session.roomName,
    type,
    creatorUserId: session.userId,
    position: parsePosition(propJson, ctx),
    def,
    timeToLive: def.timeToLive ?? 0,
    actionCount: actioned ? (partialCount > 0 ? partialCount : def.actionCount) : undefined,
  };
  liveItems.set(item.itemId, item);

  // "senderId" here is the item id, not a user id.
  sendToRoom(
    item.roomName,
    extensionPacket("con.mmoitemdeployed", new SFSObjectWriter().putInt("ownerId", session.userId).putInt("senderId", item.itemId))
  );
  broadcastDequip(ctx);
  broadcastItemAdded(item);
  setTimeout(() => tick(item), 1000);
  log(
    `${ctx.peer} - ${type} deployed as item #${item.itemId} at [${item.position.join(", ")}] (ttl=${item.timeToLive}${
      actioned ? `, actioncount=${item.actionCount}` : ""
    })`
  );
}

// One-shot consumables play on the user. Everyone else gets "con.use";
// the sender already started the prop locally. The client passes "type"
// to UsePropCMD as the experience instance id, which for a one-shot prop
// is the user's session id, not the consumable name.
function useOneShotConsumable(ctx: HandlerContext, type: string): void {
  const packet = extensionPacket(
    "con.use",
    new SFSObjectWriter().putInt("senderId", ctx.session.userId).putUtfString("type", ctx.session.playerSessionId ?? "0")
  );
  for (const entry of getByRoomExcluding(ctx.session.roomName, ctx.session.userId)) entry.send(packet);
  broadcastDequip(ctx);
  log(`${ctx.peer} - ${type} used (one-shot), con.use sent to room`);
}

function useConsumable(ctx: HandlerContext, cmd: string, type: string, partialCount: number, propJson: string | undefined): void {
  const def = CONSUMABLES[type];
  if (!def || def.serverAdded) {
    log(`${ctx.peer} - ${cmd}: unknown consumable type ${JSON.stringify(type)}, ignoring`);
    return;
  }
  switch (def.experience) {
    case "oneShot":
      useOneShotConsumable(ctx, type);
      break;
    case "world":
      deployWorldConsumable(ctx, type, def, partialCount, propJson);
      break;
    case "playerHeld":
      usePlayerHeldConsumable(ctx, type, def, partialCount);
      break;
    default:
      // TODO: partyGameLobby, with party games.
      log(`${ctx.peer} - ${cmd}: ${type} is a ${def.experience} consumable, not implemented yet`);
  }
}

// "con.use" - type = JSON SignedResponse<UsedConsumable> {type,
// partialCount}, prop = JSON properties. Sent after the client has spent
// the item through the WebAPI.
export function handleConsumableUse(innerParams: SFSObjectData, ctx: HandlerContext): void {
  const typeJson = getUtfString(innerParams, "type");
  let type: string | undefined;
  let partialCount = 0;
  try {
    const data = typeJson ? JSON.parse(typeJson)?.data : undefined;
    if (typeof data?.type === "string") type = data.type;
    if (typeof data?.partialCount === "number") partialCount = data.partialCount;
  } catch (err) {
    log(`${ctx.peer} - con.use: failed to parse "type" JSON: ${(err as Error).message}`);
  }
  if (!type) {
    log(`${ctx.peer} - con.use: no consumable type in ${typeJson ?? "(none)"}, ignoring`);
    return;
  }
  useConsumable(ctx, "con.use", type, partialCount, getUtfString(innerParams, "prop"));
}

// "con.reuse" - type = plain string, prop = JSON properties. The client
// sends it for quest-only consumables, which aren't spent. Anything else
// gets "con.reuse_error" {type, prop}, and the client falls back to
// spending one through the WebAPI and sending con.use.
export function handleConsumableReuse(innerParams: SFSObjectData, ctx: HandlerContext): void {
  const type = getUtfString(innerParams, "type") ?? "";
  const propJson = getUtfString(innerParams, "prop");
  if (!CONSUMABLES[type]?.questOnly) {
    // The client parses "prop" with LitJson, so it must be valid JSON.
    ctx.send(extensionPacket("con.reuse_error", new SFSObjectWriter().putUtfString("type", type).putUtfString("prop", propJson ?? "{}")));
    log(`${ctx.peer} <- con.reuse_error (${JSON.stringify(type)} is not reusable)`);
    return;
  }
  useConsumable(ctx, "con.reuse", type, 0, propJson);
}

// Called from l.a with "o", a JSON ActionedObject {type, id, tag}. Only
// Interact actions matter: on a world item (a pinata hit) or on a player
// (taking from a tray, or eating what you took).
export function handleConsumableInteraction(ctx: HandlerContext, action: number, objectJson: string | undefined): void {
  if (action !== LOCOMOTION_ACTION_INTERACT || !objectJson) return;
  let obj: { type?: unknown; id?: unknown };
  try {
    obj = JSON.parse(objectJson);
  } catch {
    return;
  }
  if (typeof obj?.id !== "string") return;
  if (obj.type === OBJECT_TYPE_PLAYER || obj.type === "PLAYER") {
    handlePlayerInteraction(ctx, obj.id);
  } else if (obj.type === OBJECT_TYPE_SERVER || obj.type === "SERVER") {
    handleWorldItemInteraction(Number(obj.id));
  }
}

function handleWorldItemInteraction(itemId: number): void {
  const item = liveItems.get(itemId);
  if (!item || item.actionCount === undefined || item.actionCount <= 0) return;
  item.actionCount -= 1;
  broadcastItemVariable(item, intVar("actioncount", item.actionCount));
}

// ==================== Held and shared consumables ====================
//
// A held consumable is a PLAYER-parented item built from two user
// variables: "con" ({type: "consum", name}) and "con_prop" (JSON
// {"actionCount": n}). Both must change in the same update for the client
// to add the item; "con_prop" alone is an item change, and both NULL
// removes it. Every playerHeld consumable is a shareable tray: other
// players take its `recipient` consumable (a server-added item) by
// interacting with the holder, and eat it by interacting with themselves.

// Time a player must wait between takes, matching the client's
// per-recipient cooldown on the tray.
const TAKE_COOLDOWN_MS = 2000;
// How long an eaten item stays (at actionCount 0) before it's removed, so
// every client gets to play the eat animation.
const EATEN_ITEM_REMOVE_DELAY_MS = 4000;

function conVar(name: string): SFSArrayWriter {
  const value = new SFSObjectWriter().putUtfString("type", "consum").putUtfString("name", name);
  return new SFSArrayWriter().putUtfString("con").putByte(5).putSFSObject(value).putBool(false);
}
function conPropVar(actionCount: number): SFSArrayWriter {
  return new SFSArrayWriter().putUtfString("con_prop").putByte(VARIABLE_TYPE_STRING).putUtfString(`{"actionCount":${actionCount}}`).putBool(false);
}
function nullUserVar(name: string): SFSArrayWriter {
  return new SFSArrayWriter().putUtfString(name).putByte(VARIABLE_TYPE_NULL).putNull().putBool(false);
}

function broadcastUserVars(session: Session, vars: SFSArrayWriter[]): void {
  const vl = new SFSArrayWriter();
  for (const v of vars) vl.putSFSArray(v);
  sendToRoom(session.roomName, encodePacket(0, 12, new SFSObjectWriter().putInt("u", session.userId).putSFSArray("vl", vl)));
}

function setHeldItem(session: Session, name: string, actionCount: number): void {
  session.equippedConsumable = name;
  session.heldActionCount = actionCount;
  broadcastUserVars(session, [conVar(name), conPropVar(actionCount)]);
}

function setHeldActionCount(session: Session, actionCount: number): void {
  session.heldActionCount = actionCount;
  broadcastUserVars(session, [conPropVar(actionCount)]);
}

function removeHeldItem(session: Session): void {
  session.equippedConsumable = undefined;
  session.heldActionCount = undefined;
  broadcastUserVars(session, [nullUserVar("con"), nullUserVar("con_prop")]);
}

// A tray (con.use / con.reuse). partialCount is what was left the last
// time this tray was put away.
function usePlayerHeldConsumable(ctx: HandlerContext, type: string, def: ConsumableDef, partialCount: number): void {
  const count = partialCount > 0 ? partialCount : def.totalItemQuantity ?? 1;
  setHeldItem(ctx.session, type, count);
  log(`${ctx.peer} - ${type} held out with ${count} to share`);
}

function handlePlayerInteraction(ctx: HandlerContext, targetSessionId: string): void {
  const { session } = ctx;
  // Interacting with yourself while holding a taken item eats it.
  if (targetSessionId === session.playerSessionId) {
    const name = session.equippedConsumable;
    if (!name || !CONSUMABLES[name]?.serverAdded || !session.heldActionCount) return;
    setHeldActionCount(session, 0);
    setTimeout(() => {
      if (session.equippedConsumable === name && session.heldActionCount === 0) removeHeldItem(session);
    }, EATEN_ITEM_REMOVE_DELAY_MS);
    log(`${ctx.peer} - ate ${name}`);
    return;
  }
  const holder = getByRoomExcluding(session.roomName, session.userId).find((e) => e.session.playerSessionId === targetSessionId)?.session;
  const trayName = holder?.equippedConsumable;
  const tray = trayName ? CONSUMABLES[trayName] : undefined;
  if (!holder || !tray || tray.experience !== "playerHeld" || tray.serverAdded || !holder.heldActionCount) return;
  // Hands must be free, and the recipient type must be a real prop or the
  // client throws on the unknown prop.
  if (session.equippedConsumable || !tray.recipient || !CONSUMABLES[tray.recipient]?.serverAdded) return;
  const now = Date.now();
  if (now - session.lastTakeAt < TAKE_COOLDOWN_MS) return;
  session.lastTakeAt = now;

  const left = holder.heldActionCount - 1;
  if (left > 0) setHeldActionCount(holder, left);
  else {
    // The tray experience closes itself when it sees 0, then the item goes.
    setHeldActionCount(holder, 0);
    removeHeldItem(holder);
  }
  setHeldItem(session, tray.recipient, 1);
  log(`${ctx.peer} - took ${tray.recipient} from ${holder.userName}'s ${trayName} (${left} left)`);
}

// The "con" value: {type: "consum" | "dispns" | "durable" | "pgame", name}.
export interface EquippedObject {
  type: string;
  name: string;
}

function objectConVar(con: EquippedObject): SFSArrayWriter {
  const value = new SFSObjectWriter().putUtfString("type", con.type).putUtfString("name", con.name);
  return new SFSArrayWriter().putUtfString("con").putByte(5).putSFSObject(value).putBool(false);
}

function sendUserVars(target: { send: (b: Buffer) => void }, session: Session, vars: SFSArrayWriter[]): void {
  const vl = new SFSArrayWriter();
  for (const v of vars) vl.putSFSArray(v);
  target.send(encodePacket(0, 12, new SFSObjectWriter().putInt("u", session.userId).putSFSArray("vl", vl)));
}

// Drops a held tray or taken item from the session. A tray with items left
// sends "con.partial" {data: JSON SignedResponse<UsedConsumable> {type,
// partialCount}}, which the client stores through POST
// /consumable/v1/partial. Returns whether anything was held.
function releaseHeldItem(ctx: HandlerContext, previous: string | undefined): boolean {
  const { session } = ctx;
  const count = session.heldActionCount;
  if (count === undefined) return false;
  session.heldActionCount = undefined;
  if (previous && !CONSUMABLES[previous]?.serverAdded && count > 0) {
    const payload = { goodUntil: 0, signature: "", swid: session.swid ?? "", data: { type: previous, partialCount: count } };
    ctx.send(extensionPacket("con.partial", new SFSObjectWriter().putUtfString("data", JSON.stringify(payload))));
    log(`${ctx.peer} <- con.partial (${previous}, ${count} left)`);
  }
  return true;
}

// Clears "con_prop" once a held item is gone, with "con" now `next`.
// "con_prop" can't be cleared alone while "con" is still set: the client
// reads that as an item change and dereferences the missing "con_prop".
// - next is null: {con_prop: NULL} to everyone (con is already gone).
// - otherwise: the player gets {con: next, con_prop: NULL}, which fires
//   nothing (their client equipped locally); everyone else gets
//   {con: NULL, con_prop: NULL} (item removed), then {con: next}.
function replaceHeldItem(ctx: HandlerContext, next: EquippedObject | undefined): void {
  const { session } = ctx;
  if (!next) {
    broadcastUserVars(session, [nullUserVar("con_prop")]);
    return;
  }
  sendUserVars(ctx, session, [objectConVar(next), nullUserVar("con_prop")]);
  for (const other of getByRoomExcluding(session.roomName, session.userId)) {
    sendUserVars(other, session, [nullUserVar("con"), nullUserVar("con_prop")]);
    sendUserVars(other, session, [objectConVar(next)]);
  }
}

// The client changed its own "con" variable (equip, or put away); its
// update has already been echoed to the room.
export function handleClientConChanged(ctx: HandlerContext, next: EquippedObject | undefined): void {
  const { session } = ctx;
  const previous = session.equippedConsumable;
  const nextConsumable = next?.type === "consum" ? next.name : undefined;
  session.equippedConsumable = nextConsumable;
  if (nextConsumable !== undefined && nextConsumable === previous) return;
  if (releaseHeldItem(ctx, previous)) replaceHeldItem(ctx, next);
}

// The server equips gear or a dispensable ("con" = next) for the whole
// room. A held tray or taken item is released first.
export function equipObject(ctx: HandlerContext, next: EquippedObject): void {
  const { session } = ctx;
  const previous = session.equippedConsumable;
  session.equippedConsumable = undefined;
  if (releaseHeldItem(ctx, previous)) replaceHeldItem(ctx, next);
  else broadcastUserVars(session, [objectConVar(next)]);
}

// "con.set" - client -> server only, no response.
// `data` is a JSON SignedResponse<ConsumableInventory>.
export function handleConsumableSet(innerParams: SFSObjectData, ctx: HandlerContext): void {
  const dataJson = getUtfString(innerParams, "data");
  log(`${ctx.peer} - con.set received (data=${dataJson ?? "(none)"}), no response documented`);
}
