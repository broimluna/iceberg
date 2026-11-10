import {
  SFSDataType,
  SFSObjectWriter,
  encodePacket,
  variableKindFromId,
  type Protocol,
  type SFSObjectData,
  type SFSValue,
  type VariableKind,
} from "../../sfs-wire.ts";
import { getByRoomExcluding } from "../../session-registry.ts";
import { extractRawJsonValue, fitsBytes, isOutfitJson, MAX_OUTFIT_BYTES } from "../../wire-helpers.ts";
import { handleClientConChanged, type EquippedObject } from "../consumables.ts";
import { onPlayerStateChanged } from "../../daily-tasks.ts";
import type { HandlerContext } from "../context.ts";
import { refreshAppearance, variableEntry } from "../../appearance.ts";

// RequestType.SetUserVariables = 12. The request carries only "vl"; the
// server broadcasts {u, vl} to everyone in the room, including the sender.
// The client only applies the variables to its own user when that echo
// arrives, so the sender needs it too.
export function handleSetUserVariables(params: SFSObjectData, ctx: HandlerContext): void {
  const raw = params["vl"];
  if (raw?.type === SFSDataType.SFS_ARRAY) {
    const accepted = raw.value.map((v) => neutralizeVariableType(v, ctx.session.protocol)).filter((v) => isClientVariable(v, ctx));
    if (accepted.length === 0) return;
    const saved = { asked: false };
    const vl: SFSValue = {
      type: SFSDataType.SFS_ARRAY,
      value: accepted.map((v) => unwrapSignedVariable(v, ctx, saved)).filter((v): v is SFSValue => v !== null),
    };
    // A signed player's outfit, colour and tube come from the web API's record.
    if (saved.asked) void refreshAppearance(ctx.session, ctx.send, "variable set by the client");
    if (vl.value.length === 0) return;
    // While the server has "con_prop" set (a held tray or taken item), a
    // "con" change alone reads as a new PlayerHeldItem on every client,
    // the sender's included. handleClientConChanged sends the change
    // instead, or nothing if the item is the same.
    const echoed = ctx.session.heldActionCount === undefined ? vl.value : vl.value.filter((v) => !isConEntry(v));
    if (echoed.length > 0) {
      const echo: SFSValue = { type: SFSDataType.SFS_ARRAY, value: echoed };
      const packet = encodePacket(0, 12, new SFSObjectWriter().putInt("u", ctx.session.userId).putRaw("vl", echo));
      ctx.send(packet);
      for (const entry of getByRoomExcluding(ctx.session.roomName, ctx.session.userId)) entry.send(packet);
      console.log(`[${new Date().toISOString()}] ${ctx.peer} <- set user variables broadcast (u=${ctx.session.userId})`);
    }
    // After the echo, so any follow-up (con.partial, clearing con_prop)
    // arrives after the client's own change.
    trackEquippedConsumable(vl.value, ctx);
    trackLocomotionState(vl.value, ctx);
    // Outfit, colour, tube and locomotion state feed daily-challenge switches.
    onPlayerStateChanged(ctx.session);
  } else {
    console.log(`[${new Date().toISOString()}] ${ctx.peer} - SetUserVariables with no "vl" array, not responding`);
  }
}

// The variables the client sets (SocketUserVars) and the type it sends
// each as; colour, tube and outfit are SignedResponse JSON text. Any of
// them may be NULL, which removes it. sess, con_prop and on_quest are set
// by the server only; proto (PrototypeSetState) is never called. Everything else is dropped, so a modified client
// can't rewrite variables other players' clients rely on.
const CLIENT_VARIABLES: Record<string, VariableKind> = {
  outfit: "string", colour: "string", tube: "string",
  con: "object", bubble: "object",
  loc: "int", awayfromkeyboard: "int", tempheadstatus: "int",
};
const VALUE_TYPE: Partial<Record<VariableKind, SFSDataType>> = {
  null: SFSDataType.NULL, int: SFSDataType.INT, string: SFSDataType.UTF_STRING, object: SFSDataType.SFS_OBJECT,
};
// con is {type, name}; bubble is {value, diveState}.
const MAX_OBJECT_KEYS = 4;
const MAX_OBJECT_STRING_BYTES = 255;

function isClientVariable(v: SFSValue, ctx: HandlerContext): boolean {
  const why = rejectVariable(v);
  if (why) console.log(`[${new Date().toISOString()}] ${ctx.peer} - user variable dropped (${why})`);
  return why === null;
}

function rejectVariable(v: SFSValue): string | null {
  if (v.type !== SFSDataType.SFS_ARRAY) return "not an entry";
  const [name, kind, value] = v.value;
  if (name?.type !== SFSDataType.UTF_STRING || !Object.hasOwn(CLIENT_VARIABLES, name.value)) return `not a client variable: ${JSON.stringify(String(name?.value)).slice(0, 40)}`;
  if (kind?.type !== SFSDataType.VARIABLE_TYPE || !value) return `${name.value}: unknown type`;
  if (kind.value !== "null" && kind.value !== CLIENT_VARIABLES[name.value]) return `${name.value}: wrong type ${kind.value}`;
  if (value.type !== VALUE_TYPE[kind.value]) return `${name.value}: value doesn't match its type`;
  if (value.type === SFSDataType.UTF_STRING && !fitsBytes(value.value, MAX_OUTFIT_BYTES)) return `${name.value}: too long`;
  if (value.type === SFSDataType.SFS_OBJECT) {
    const entries = Object.values(value.value);
    if (entries.length > MAX_OBJECT_KEYS) return `${name.value}: too many fields`;
    for (const e of entries) {
      if (e.type === SFSDataType.UTF_STRING ? !fitsBytes(e.value, MAX_OBJECT_STRING_BYTES) : typeof e.value === "object" && e.value !== null) {
        return `${name.value}: bad field`;
      }
    }
  }
  return null;
}

function isConEntry(v: SFSValue): boolean {
  if (v.type !== SFSDataType.SFS_ARRAY) return false;
  const name = v.value[0];
  return name?.type === SFSDataType.UTF_STRING && name.value === "con";
}

// The client equips consumables itself by setting "con" = {type: "consum",
// name}, and clears "con" with a NULL variable. Each entry is
// [name, type, value, isPrivate].
function trackEquippedConsumable(vars: SFSValue[], ctx: HandlerContext): void {
  for (const v of vars) {
    if (v.type !== SFSDataType.SFS_ARRAY) continue;
    const [name, , value] = v.value;
    if (name?.type !== SFSDataType.UTF_STRING || name.value !== "con") continue;
    let next: EquippedObject | undefined;
    if (value?.type === SFSDataType.SFS_OBJECT) {
      const type = value.value["type"];
      const itemName = value.value["name"];
      if (type?.type === SFSDataType.UTF_STRING && itemName?.type === SFSDataType.UTF_STRING) {
        next = { type: type.value, name: itemName.value };
      }
    }
    handleClientConChanged(ctx, next);
  }
}

// "loc": PlayerStateService.SetLocomotionState sends the
// Domain.LocomotionState byte, or NULL for Default.
function trackLocomotionState(vars: SFSValue[], ctx: HandlerContext): void {
  for (const v of vars) {
    if (v.type !== SFSDataType.SFS_ARRAY) continue;
    const [name, , value] = v.value;
    if (name?.type !== SFSDataType.UTF_STRING || name.value !== "loc") continue;
    ctx.session.locomotionState = typeof value?.value === "number" ? value.value : 0;
  }
}

// The client's type byte uses its own protocol's numbering. It's replaced
// with the kind, so the echo is numbered for each recipient.
function neutralizeVariableType(v: SFSValue, protocol: Protocol): SFSValue {
  if (v.type !== SFSDataType.SFS_ARRAY) return v;
  const typeByte = v.value[1];
  if (typeByte?.type !== SFSDataType.BYTE) return v;
  const kind = variableKindFromId(typeByte.value, protocol);
  if (!kind) return v;
  const items = [...v.value];
  items[1] = { type: SFSDataType.VARIABLE_TYPE, value: kind };
  return { type: SFSDataType.SFS_ARRAY, value: items };
}

// The client sets "colour", "tube" and "outfit" to a JSON SignedResponse
// (Profile, EquipTubeResponse, PlayerOutfitDetails), but reads other
// players' values as GetIntValue() for colour and tube, and as a bare
// PlayerOutfitDetails for outfit. The server unwraps them before they go
// out, and keeps them for the user-variable snapshot that late joiners get.
// A colour, tube or outfit string that isn't that JSON is dropped (null):
// relayed as it came, the rest of the room would be handed a string where
// their clients read an int or parse an outfit.
function unwrapSignedVariable(v: SFSValue, ctx: HandlerContext, saved: { asked: boolean }): SFSValue | null {
  if (v.type !== SFSDataType.SFS_ARRAY) return v;
  const [name, , value] = v.value;
  if (name?.type !== SFSDataType.UTF_STRING || value?.type !== SFSDataType.UTF_STRING) return v;
  const json = value.value;
  const { session } = ctx;
  const drop = () => {
    console.log(`[${new Date().toISOString()}] ${ctx.peer} - user variable dropped (${name.value}: not the web API's JSON)`);
    return null;
  };
  // For a signed login the client's value is not relayed at all: the web API
  // has what is saved, and refreshAppearance shows that (appearance.ts).
  if (session.signedLogin && (name.value === "colour" || name.value === "tube" || name.value === "outfit")) {
    saved.asked = true;
    return null;
  }
  try {
    switch (name.value) {
      case "colour": {
        const colour = JSON.parse(json)?.data?.colour;
        if (!isInt32(colour)) return drop();
        session.colour = colour;
        return variableEntry("colour", "int", { type: SFSDataType.INT, value: colour });
      }
      case "tube": {
        const tubeId = JSON.parse(json)?.data?.tubeId;
        if (!isInt32(tubeId)) return drop();
        session.selectedTubeId = tubeId;
        return variableEntry("tube", "int", { type: SFSDataType.INT, value: tubeId });
      }
      case "outfit": {
        // Kept as raw text: equipment ids and timestamps are 64-bit.
        JSON.parse(json);
        const outfit = extractRawJsonValue(json, "data");
        if (!isOutfitJson(outfit)) return drop();
        session.outfitJson = outfit;
        return variableEntry("outfit", "string", { type: SFSDataType.UTF_STRING, value: outfit });
      }
    }
  } catch {
    return drop();
  }
  return v;
}

const isInt32 = (n: unknown): n is number => Number.isInteger(n) && (n as number) >= -0x80000000 && (n as number) <= 0x7fffffff;
