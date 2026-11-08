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
import { extractRawJsonValue, fitsBytes, MAX_OUTFIT_BYTES } from "../../wire-helpers.ts";
import { handleClientConChanged, type EquippedObject } from "../consumables.ts";
import { onPlayerStateChanged } from "../../daily-tasks.ts";
import type { HandlerContext } from "../context.ts";

// RequestType.SetUserVariables = 12. The request carries only "vl"; the
// server broadcasts {u, vl} to everyone in the room, including the sender.
// The client only applies the variables to its own user when that echo
// arrives, so the sender needs it too.
export function handleSetUserVariables(params: SFSObjectData, ctx: HandlerContext): void {
  const raw = params["vl"];
  if (raw?.type === SFSDataType.SFS_ARRAY) {
    const accepted = raw.value.map((v) => neutralizeVariableType(v, ctx.session.protocol)).filter((v) => isClientVariable(v, ctx));
    if (accepted.length === 0) return;
    const vl: SFSValue = {
      type: SFSDataType.SFS_ARRAY,
      value: accepted.map((v) => unwrapSignedVariable(v, ctx)),
    };
    const packet = encodePacket(0, 12, new SFSObjectWriter().putInt("u", ctx.session.userId).putRaw("vl", vl));
    ctx.send(packet);
    for (const entry of getByRoomExcluding(ctx.session.roomName, ctx.session.userId)) entry.send(packet);
    console.log(`[${new Date().toISOString()}] ${ctx.peer} <- set user variables broadcast (u=${ctx.session.userId})`);
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

function variableEntry(name: string, kind: VariableKind, value: SFSValue): SFSValue {
  return {
    type: SFSDataType.SFS_ARRAY,
    value: [
      { type: SFSDataType.UTF_STRING, value: name },
      { type: SFSDataType.VARIABLE_TYPE, value: kind },
      value,
      { type: SFSDataType.BOOL, value: false },
    ],
  };
}

// The client sets "colour", "tube" and "outfit" to a JSON SignedResponse
// (Profile, EquipTubeResponse, PlayerOutfitDetails), but reads other
// players' values as GetIntValue() for colour and tube, and as a bare
// PlayerOutfitDetails for outfit. The server unwraps them before they go
// out, and keeps them for the user-variable snapshot that late joiners get.
function unwrapSignedVariable(v: SFSValue, ctx: HandlerContext): SFSValue {
  if (v.type !== SFSDataType.SFS_ARRAY) return v;
  const [name, , value] = v.value;
  if (name?.type !== SFSDataType.UTF_STRING || value?.type !== SFSDataType.UTF_STRING) return v;
  const json = value.value;
  const { session } = ctx;
  try {
    switch (name.value) {
      case "colour": {
        const colour = JSON.parse(json)?.data?.colour;
        if (!Number.isInteger(colour)) return v;
        session.colour = colour;
        return variableEntry("colour", "int", { type: SFSDataType.INT, value: colour });
      }
      case "tube": {
        const tubeId = JSON.parse(json)?.data?.tubeId;
        if (!Number.isInteger(tubeId)) return v;
        session.selectedTubeId = tubeId;
        return variableEntry("tube", "int", { type: SFSDataType.INT, value: tubeId });
      }
      case "outfit": {
        // Kept as raw text: equipment ids and timestamps are 64-bit.
        JSON.parse(json);
        const outfit = extractRawJsonValue(json, "data");
        // An oversized outfit isn't stored for late joiners; it passes
        // through unchanged like any non-SignedResponse value.
        if (!outfit?.startsWith("{") || !fitsBytes(outfit, MAX_OUTFIT_BYTES)) return v;
        session.outfitJson = outfit;
        return variableEntry("outfit", "string", { type: SFSDataType.UTF_STRING, value: outfit });
      }
    }
  } catch {
    // Not a SignedResponse; pass it through unchanged.
  }
  return v;
}
