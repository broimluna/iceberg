import type { Session } from "../session.ts";
import type { OutgoingPacket } from "../sfs-wire.ts";

// What every handler receives: the requesting session and a way to reply.
export interface HandlerContext {
  session: Session;
  peer: string;
  send: (packet: OutgoingPacket) => void;
}
