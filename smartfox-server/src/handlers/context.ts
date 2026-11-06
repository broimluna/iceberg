import type { Session } from "../session.ts";

// Passed to every handler - mirrors what a real SFS2X extension handler
// gets for free from its base class (the requesting user/session, a way to
// send a response) without dragging the raw net.Socket or transport-mode
// bookkeeping into handler code.
export interface HandlerContext {
  session: Session;
  peer: string;
  send: (data: Buffer) => void;
}
