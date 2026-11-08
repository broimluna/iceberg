import { SFSObjectWriter, encodePacket } from "../sfs-wire.ts";
import { getAll } from "../session-registry.ts";
import { broadcastSystem } from "./reply.ts";

// Server-wide notices. The OpenCPI client shows "server.alert" (free text)
// and "server.restarting" (a localization key) as popups; clients without
// those commands ignore them. SFS3 connections are OpenCPI builds; SFS2X
// connections (retail and older OpenCPI builds) may lack the popup, so
// they also get a system chat bubble.
const MAX_ALERT = 500;
const RESTARTING_TOKEN = "GlobalUI.ErrorMessages.ServerRestarting";

function popup(cmd: string, message: string) {
  return encodePacket(1, 13, new SFSObjectWriter().putUtfString("c", cmd).putSFSObject("p", new SFSObjectWriter().putUtfString("message", message)));
}

export function notifyAll(text: string): void {
  const packet = popup("server.alert", text.slice(0, MAX_ALERT));
  for (const entry of getAll()) entry.send(packet);
  broadcastSystem(text, (entry) => entry.session.protocol === "sfs2x");
}

/** The "server restarting" popup, plus text for the SFS2X bubble. */
export function notifyRestarting(text: string): void {
  const packet = popup("server.restarting", RESTARTING_TOKEN);
  for (const entry of getAll()) entry.send(packet);
  broadcastSystem(text, (entry) => entry.session.protocol === "sfs2x");
}
