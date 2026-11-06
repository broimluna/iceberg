import type { SFSObjectData } from "../sfs-wire.ts";
import { getUtfString } from "../wire-helpers.ts";
import type { HandlerContext } from "./context.ts";

// SmartfoxCommand.MEMBERSHIP_REFRESH ("membership.refresh",
// SMARTFOX_PACKETS_DOCUMENTATION.md's Membership section) - documented
// OUT only: `rights` = JSON `SignedResponse<MembershipRightsRefresh>`.
// No IN payload/response is documented anywhere in the packet doc (unlike
// validate.state, this one isn't marked BOTH) - the old recovered Java
// extension invents a `{success: bool}` ack, but nothing in the
// decompiled dispatch switch (ClubPenguinClient.decompiled.cs's
// onExtensionResponse) has a case for MEMBERSHIP_REFRESH at all, so
// there's no evidence the client is even listening for a reply. Logging
// only, not guessing a response shape nothing confirms is expected.
export function handleMembershipRefresh(innerParams: SFSObjectData, ctx: HandlerContext): void {
  const rightsJson = getUtfString(innerParams, "rights");
  console.log(`[${new Date().toISOString()}] ${ctx.peer} - membership.refresh received (rights=${rightsJson ?? "(none)"}), no response sent (none documented)`);
}
