import { SFSObjectWriter, encodePacket } from "../sfs-wire.ts";
import type { HandlerContext } from "./context.ts";

// "validate.state" - the client sends a bare request; the reply is `data`
// = JSON SignedResponse<InWorldState>, where (from the client source):
//   struct InWorldState { RoomIdentifier location; Vector3 position; string equippedItem; }
//   class RoomIdentifier { string world; Language language; ZoneId zoneId; string contentIdentifier; }
// world/language aren't tracked yet, so they're left empty. The signature
// is a placeholder; the client never verifies it.
export function handleValidateState(ctx: HandlerContext): void {
  const { session } = ctx;
  const inWorldState = {
    location: {
      world: "",
      language: 0, // Language.none - not tracked yet
      zoneId: { name: session.roomName, instanceId: "" },
      contentIdentifier: "",
    },
    position: session.lastPosition ? { x: session.lastPosition[0] ?? 0, y: session.lastPosition[1] ?? 0, z: session.lastPosition[2] ?? 0 } : { x: 0, y: 0, z: 0 },
    equippedItem: session.equippedItemName ?? "",
  };
  const signedResponse = {
    goodUntil: Date.now() + 300000,
    swid: session.swid ?? "{SWID}",
    data: inWorldState,
    signature: `server_signature_${Date.now()}`,
  };
  const responseP = new SFSObjectWriter().putUtfString("data", JSON.stringify(signedResponse));
  ctx.send(encodePacket(1, 13, new SFSObjectWriter().putUtfString("c", "validate.state").putSFSObject("p", responseP)));
  console.log(`[${new Date().toISOString()}] ${ctx.peer} <- validate.state response (room=${session.roomName}, equipped=${inWorldState.equippedItem || "none"})`);
}
