import type { Session } from "../session.ts";

// What every handler receives: the requesting session and a way to reply.
export interface HandlerContext {
  session: Session;
  peer: string;
  send: (data: Buffer) => void;
}
