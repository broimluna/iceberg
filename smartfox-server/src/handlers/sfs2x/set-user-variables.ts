import { SFSDataType, SFSObjectWriter, encodePacket, type SFSObjectData, type SFSValue } from "../../sfs-wire.ts";
import { getByRoomExcluding } from "../../session-registry.ts";
import { handleClientConChanged, type EquippedObject } from "../consumables.ts";
import type { HandlerContext } from "../context.ts";

// RequestType.SetUserVariables = 12. The request carries only "vl"; the
// server broadcasts {u, vl} to everyone in the room, including the sender.
// The client only applies the variables to its own user when that echo
// arrives, so the sender needs it too.
export function handleSetUserVariables(params: SFSObjectData, ctx: HandlerContext): void {
  const vl = params["vl"];
  if (vl?.type === SFSDataType.SFS_ARRAY) {
    const packet = encodePacket(0, 12, new SFSObjectWriter().putInt("u", ctx.session.userId).putRaw("vl", vl));
    ctx.send(packet);
    for (const entry of getByRoomExcluding(ctx.session.roomName, ctx.session.userId)) entry.send(packet);
    console.log(`[${new Date().toISOString()}] ${ctx.peer} <- set user variables broadcast (u=${ctx.session.userId})`);
    // After the echo, so any follow-up (con.partial, clearing con_prop)
    // arrives after the client's own change.
    trackEquippedConsumable(vl.value, ctx);
  } else {
    console.log(`[${new Date().toISOString()}] ${ctx.peer} - SetUserVariables with no "vl" array, not responding`);
  }
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
