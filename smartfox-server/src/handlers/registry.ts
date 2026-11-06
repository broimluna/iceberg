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
import { handleConsumableSet } from "./consumables.ts";

export type ExtensionHandler = (innerParams: SFSObjectData, ctx: HandlerContext) => void;

// RequestType.CallExtension = 13, controller 1 (ExtensionRequest's real
// key names, SmartFox2X.decompiled.cs:11567: c=cmd, p=params, r=room).
// Same command-name -> handler shape a Java SFS2X extension uses
// (`addRequestHandler(SmartfoxCommand.X.toString(), X.class)`), one
// function per command instead of one class. Full source-of-truth
// command list (all 39, with confirmed wire shapes and IN/OUT direction)
// is docs/SMARTFOX_PACKETS_DOCUMENTATION.md. Commands genuinely not reachable yet - real per-room
// broadcast to other connected players (con.use/con.reuse,
// room.igloo_updated, PROTOTYPE, party games) - now CAN use the
// cross-connection room registry added for the reward-integrity pass
// (session-registry.ts's getByRoom), just not wired up yet; everything
// else still missing (daily-challenge tasks, island targets) is deferred
// for being large and partly-guessed in the old source, not for any
// architectural blocker. Scheduled world objects (geysers, blinking
// lights) are NOT a CallExtension command at all - they're SFS2X's
// built-in MMO Room Items API (controller 0, actions 30/1007), now
// implemented in world-objects.ts and hooked in at room join
// (handlers/sfs2x/login.ts), independent of this registry. Unregistered
// commands fall through to the "no handler for extension cmd" log in
// server.ts.
export const extensionHandlers: Record<string, ExtensionHandler> = {
  "quest.set": (_p, ctx) => handleQuestSet(ctx),
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
  "reward.broadcast": handleRewardBroadcast,
};
