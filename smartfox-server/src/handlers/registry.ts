import type { SFSObjectData } from "../sfs-wire.ts";
import type { HandlerContext } from "./context.ts";
import { handleChatMsg, handleChatActivity } from "./chat.ts";
import { handleLocomotionAction } from "./locomotion.ts";
import { handleQuestSet, handleQuestCompleteObjective, handleRewardBroadcast } from "./quest.ts";
import { handleDurableEquip, handleDispensableEquip } from "./gear.ts";
import { handleZoneLogout } from "./logout.ts";
import { handleTimeGet } from "./time.ts";
import { handleEncryptionGet } from "./encryption.ts";
import { handleValidateState } from "./validation.ts";
import { handleMembershipRefresh } from "./membership.ts";
import { handlePlayerLocation } from "./player-location.ts";
import { handlePickup } from "./pickup.ts";
import { handleIglooUpdated } from "./igloo.ts";
import { handlePrototypeAction } from "./prototype.ts";
import { handleWebServiceEvent } from "./web-service-event.ts";
import { handleConsumableSet, handleConsumableUse, handleConsumableReuse } from "./consumables.ts";

export type ExtensionHandler = (innerParams: SFSObjectData, ctx: HandlerContext) => void;

// Extension commands (controller 1, action 13; envelope c=cmd, p=params,
// r=room), mapped by command name. The full command list with wire shapes
// is in docs/SMARTFOX_PACKETS_DOCUMENTATION.md. Unregistered commands are
// logged by server.ts. Scheduled world objects aren't extension commands;
// see world-objects.ts.
export const extensionHandlers: Record<string, ExtensionHandler> = {
  "quest.set": handleQuestSet,
  "chat.msg": handleChatMsg,
  "chat.activity": (_p, ctx) => handleChatActivity("chat.activity", ctx),
  "chat.activity_cancel": (_p, ctx) => handleChatActivity("chat.activity_cancel", ctx),
  "l.a": handleLocomotionAction,
  "quest.c_obj": handleQuestCompleteObjective,
  "zone.logout": (_p, ctx) => handleZoneLogout(ctx),
  "dispensable.equip": handleDispensableEquip,
  "durable.equip": handleDurableEquip,
  "time.get": handleTimeGet,
  "encryption.get": handleEncryptionGet,
  "validate.state": (_p, ctx) => handleValidateState(ctx),
  "membership.refresh": handleMembershipRefresh,
  "zone.player_location": handlePlayerLocation,
  "task.p": handlePickup,
  "con.set": handleConsumableSet,
  "con.use": handleConsumableUse,
  "con.reuse": handleConsumableReuse,
  "reward.broadcast": handleRewardBroadcast,
  "room.igloo_updated": handleIglooUpdated,
  proto: handlePrototypeAction,
};

// Most commands match by exact name. "wsevent.{type}" carries the event
// type in the command name itself.
export function findExtensionHandler(cmd: string): ExtensionHandler | undefined {
  if (Object.hasOwn(extensionHandlers, cmd)) return extensionHandlers[cmd];
  if (cmd.startsWith("wsevent.")) return handleWebServiceEvent;
  return undefined;
}
