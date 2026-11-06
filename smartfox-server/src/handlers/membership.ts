import type { SFSObjectData } from "../sfs-wire.ts";
import { getUtfString } from "../wire-helpers.ts";
import type { HandlerContext } from "./context.ts";

// "membership.refresh" - client -> server only. `rights` is a JSON
// SignedResponse<MembershipRightsRefresh>. The client's extension-response
// dispatcher has no case for this command, so it doesn't expect a reply.
export function handleMembershipRefresh(innerParams: SFSObjectData, ctx: HandlerContext): void {
  const rightsJson = getUtfString(innerParams, "rights");
  console.log(`[${new Date().toISOString()}] ${ctx.peer} - membership.refresh received (rights=${rightsJson ?? "(none)"}), no response sent (none documented)`);
}
