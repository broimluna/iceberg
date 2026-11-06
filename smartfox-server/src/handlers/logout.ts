import { SFSObjectWriter, encodePacket } from "../sfs-wire.ts";
import type { HandlerContext } from "./context.ts";

// SmartfoxCommand.LEAVE_ROOM ("zone.logout" is the wire string, the enum
// name is misleading - ClubPenguinClient.decompiled.cs:7704-7705). Sent by
// GameServer.LeaveRoom(), which is fire-and-forget over the extension
// channel and does NOT itself disconnect - it only sets SfsRoomToLeave and
// waits for GameServerEvent.ROOM_LEAVE. ROOM_LEAVE only fires from
// onConnectionLost when the TCP connection actually closes with
// ClientDisconnectionReason.MANUAL and SfsRoomToLeave is set - and the
// client only ever calls mt.Disconnect() (the thing that produces that
// MANUAL close) from onLogout, which fires on the real SFS2X system-level
// Logout response (SFSEvent.LOGOUT, dispatched by FnLogout,
// RequestType.Logout=2). So answering "zone.logout" with another
// extension ack does nothing - the client is waiting on controller 0
// action 2, not another c=1 a=13 packet. FnLogout only reads
// LogoutRequest.KEY_ZONE_NAME ("zn") from the payload; HandleLogout()
// itself just resets local SFS2X-level state and does not close the
// socket - the client's own onLogout does that. Without this, "Logout"/
// "quit to menu" hangs forever waiting for ROOM_LEAVE.
export function handleZoneLogout(ctx: HandlerContext): void {
  ctx.send(encodePacket(0, 2, new SFSObjectWriter().putUtfString("zn", ctx.session.zoneName)));
  console.log(`[${new Date().toISOString()}] ${ctx.peer} <- logout response (zn=${ctx.session.zoneName})`);
}
