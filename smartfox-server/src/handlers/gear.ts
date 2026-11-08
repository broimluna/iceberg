import type { SFSObjectData } from "../sfs-wire.ts";
import { getInt, getUtfString } from "../wire-helpers.ts";
import { equipObject } from "./consumables.ts";
import type { HandlerContext } from "./context.ts";
import { logSafe } from "../log-safe.ts";

// Prop id -> server name and kind, from the game's PropDefinition data
// (ServerData 899003f22ddc395758bdcfb96f13fa5cd6721775.json).
// PropType 2 = durable (durable.equip), PropType 1 = dispensable
// (dispensable.equip).
export const PROP_CATALOG: Record<number, { nameOnServer: string; kind: "durable" | "dispns" }> = {
  // PropType 2 - Durable (durable.equip)
  11: { nameOnServer: "GearDrums", kind: "durable" },
  12: { nameOnServer: "GearFirstAidKit", kind: "durable" },
  13: { nameOnServer: "GearFishDogMultiTool", kind: "durable" },
  14: { nameOnServer: "GearGuitar", kind: "durable" },
  15: { nameOnServer: "GearJackhammer", kind: "durable" },
  16: { nameOnServer: "GearKeytar", kind: "durable" },
  17: { nameOnServer: "GearPirateKit", kind: "durable" },
  18: { nameOnServer: "GearScepter", kind: "durable" },
  19: { nameOnServer: "GearShield", kind: "durable" },
  20: { nameOnServer: "GearSword", kind: "durable" },
  66: { nameOnServer: "GearTrafficSign", kind: "durable" },
  71: { nameOnServer: "GearPomPomsBlue", kind: "durable" },
  72: { nameOnServer: "GearPomPomsRed", kind: "durable" },
  73: { nameOnServer: "GearGaryGear", kind: "durable" },
  77: { nameOnServer: "GearCPSNCamera", kind: "durable" },
  86: { nameOnServer: "GearDance", kind: "durable" },
  87: { nameOnServer: "GearScroogeMcDuckCane", kind: "durable" },
  101: { nameOnServer: "AcousticGuitarGear", kind: "durable" },
  103: { nameOnServer: "MicrophoneGear", kind: "durable" },
  105: { nameOnServer: "BongoDrumsGear", kind: "durable" },
  112: { nameOnServer: "CellPhone", kind: "durable" },
  113: { nameOnServer: "Map", kind: "durable" },
  114: { nameOnServer: "DressingBooth", kind: "durable" },
  115: { nameOnServer: "IglooPlans", kind: "durable" },
  129: { nameOnServer: "GearFlowerWand", kind: "durable" },
  154: { nameOnServer: "MedievalGear", kind: "durable" },
  // PropType 1 - InteractiveObject (dispensable.equip)
  4: { nameOnServer: "Dance", kind: "dispns" },
  5: { nameOnServer: "Drums", kind: "dispns" },
  7: { nameOnServer: "FirstAidKit", kind: "dispns" },
  8: { nameOnServer: "FishDogMultiTool", kind: "dispns" },
  9: { nameOnServer: "FishingRod", kind: "dispns" },
  10: { nameOnServer: "FishingRodGame", kind: "dispns" },
  21: { nameOnServer: "Guitar", kind: "dispns" },
  26: { nameOnServer: "Keytar", kind: "dispns" },
  31: { nameOnServer: "PirateKit", kind: "dispns" },
  36: { nameOnServer: "ScepterProp", kind: "dispns" },
  37: { nameOnServer: "Shield", kind: "dispns" },
  43: { nameOnServer: "Sword", kind: "dispns" },
  57: { nameOnServer: "JackHammer", kind: "dispns" },
  70: { nameOnServer: "CPSNCamera", kind: "dispns" },
  74: { nameOnServer: "PomPomsRed", kind: "dispns" },
  75: { nameOnServer: "PomPomsBlue", kind: "dispns" },
  76: { nameOnServer: "GaryGear", kind: "dispns" },
  78: { nameOnServer: "YetiRescueKit", kind: "dispns" },
  100: { nameOnServer: "AcousticGuitar", kind: "dispns" },
  102: { nameOnServer: "Microphone", kind: "dispns" },
  104: { nameOnServer: "BongoDrums", kind: "dispns" },
  124: { nameOnServer: "PizzaDispensible", kind: "dispns" },
  125: { nameOnServer: "HotChocolateDispensible", kind: "dispns" },
  126: { nameOnServer: "SquidStickDispensible", kind: "dispns" },
  127: { nameOnServer: "FluffCakeDispensible", kind: "dispns" },
  128: { nameOnServer: "CandyCaneDispensible", kind: "dispns" },
  146: { nameOnServer: "BirthdayCakeSingleDispensible", kind: "dispns" },
  147: { nameOnServer: "SilverAcousticGuitar", kind: "dispns" },
};

// Equips a prop by setting the player's "con" user variable ({type, name})
// for the whole room via SetUserVariables (controller 0, action 12).
// The equipping client has already put the prop in its own hand and
// ignores "con" for itself; everyone else gets DURABLE_EQUIPPED /
// DISPENSABLE_EQUIPPED. "con_prop" must NOT be sent: "con" + "con_prop"
// makes a PlayerHeldItem, and for a prop that isn't server-added the
// client calls onPropUsed, which clears the local player's held object
// and puts the prop straight back away.
export function sendEquippedObjectVariable(kind: "durable" | "dispns", nameOnServer: string, ctx: HandlerContext): void {
  // Reported back by validate.state.
  ctx.session.equippedItemName = nameOnServer;
  equipObject(ctx, { type: kind, name: nameOnServer });
  console.log(`[${new Date().toISOString()}] ${ctx.peer} <- set user variables to room (con={type:${kind},name:${nameOnServer}})`);
}

// "dispensable.equip" - {"type": <prop id int>}. No reply; the client
// reacts only to the user-variable update.
export function handleDispensableEquip(innerParams: SFSObjectData, ctx: HandlerContext): void {
  const propId = getInt(innerParams, "type");
  const prop = propId !== undefined ? PROP_CATALOG[propId] : undefined;
  if (prop) {
    sendEquippedObjectVariable(prop.kind, prop.nameOnServer, ctx);
  } else {
    console.log(`[${new Date().toISOString()}] ${ctx.peer} - dispensable.equip: unknown prop id ${logSafe(propId)}, not sending con variable`);
  }
}

// "durable.equip" - unlike dispensable.equip, "type" is a JSON string of
// SignedResponse<EquipDurableResponse>; the prop id is data.propId.
export function handleDurableEquip(innerParams: SFSObjectData, ctx: HandlerContext): void {
  const typeJson = getUtfString(innerParams, "type");
  let propId: number | undefined;
  try {
    propId = typeJson ? JSON.parse(typeJson)?.data?.propId : undefined;
  } catch (err) {
    console.log(`[${new Date().toISOString()}] ${ctx.peer} - durable.equip: failed to parse "type" JSON: ${(err as Error).message}`);
  }
  const prop = propId !== undefined ? PROP_CATALOG[propId] : undefined;
  if (prop) {
    sendEquippedObjectVariable(prop.kind, prop.nameOnServer, ctx);
  } else {
    console.log(`[${new Date().toISOString()}] ${ctx.peer} - durable.equip: unknown prop id ${logSafe(propId)} (raw type=${logSafe(typeJson)}), not sending con variable`);
  }
}
