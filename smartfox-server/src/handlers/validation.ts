import { SFSObjectWriter, encodePacket } from "../sfs-wire.ts";
import type { HandlerContext } from "./context.ts";

// SmartfoxCommand.GET_SIGNED_STATE ("validate.state",
// SMARTFOX_PACKETS_DOCUMENTATION.md's Membership/validation/equipment
// section) - BOTH direction: OUT is a bare request, no payload
// (`GetSignedStateOfLocalPlayer()` calls plain `send(SmartfoxCommand.
// GET_SIGNED_STATE)`), IN is `data` -> JSON `SignedResponse<InWorldState>`.
//
// InWorldState's exact field shape is decompiled-source-confirmed, not
// guessed (ClubPenguinClient.decompiled.cs:9588-9596):
//   struct InWorldState { RoomIdentifier location; Vector3 position; string equippedItem; }
//   class RoomIdentifier { string world; Language language; ZoneId zoneId; string contentIdentifier; }
// This is a genuinely different shape from the old recovered Java
// extension's GET_SIGNED_STATE.java (which invented sessionId/room/
// locomotionState fields that don't match InWorldState at all - take it
// as a plausible historical implementation, not this project's source of
// truth, now that the real struct's been found).
//
// `location.world`/`location.language` aren't tracked anywhere in
// Session yet - login.ts only ever extracted `data.room` (a plain string)
// from the client's own joinRoomData, never a structured RoomIdentifier -
// so both are left at their empty defaults here rather than guessed.
// `location.zoneId.name` uses the room name we do have (same field
// handlers/gear.ts and the room/igloo code already treat as the
// canonical room identifier).
//
// The "signature" field is confirmed-fine as a placeholder string for a
// private server; this is not a corner being cut, it matches how the client actually
// behaves (never cryptographically checked).
export function handleValidateState(ctx: HandlerContext): void {
  const { session } = ctx;
  const inWorldState = {
    location: {
      world: "",
      language: 0, // Language.none (ClubPenguinClient.decompiled.cs) - not tracked, see comment above
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
