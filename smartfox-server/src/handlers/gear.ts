import { SFSObjectWriter, SFSArrayWriter, encodePacket, type SFSObjectData } from "../sfs-wire.ts";
import { getInt, getUtfString } from "../wire-helpers.ts";
import type { HandlerContext } from "./context.ts";

const VARIABLE_TYPE_OBJECT = 5;
const VARIABLE_TYPE_STRING = 4;

// PropDefinition catalog lookup (id -> {NameOnServer, PropType}), pulled
// straight from real CDN ServerData JSON
// (1539617431/ServerData/899003f22ddc395758bdcfb96f13fa5cd6721775.json),
// not guessed. PropType 2 = Durable (durable.equip/EQUIP_DURABLE), PropType
// 1 = InteractiveObject (dispensable.equip/EQUIP_DISPENSABLE) - confirmed
// from ReMix-Game.decompiled.cs:124589's LocalPlayerRetrieveProp switch.
// Every id cross-checked against a real historical Java SFS2X extension's
// own hardcoded id->name gear tables and matched byte-for-byte on both
// name and PropType/kind for every id present in both sources.
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

// SocketUserVars.EQUIPPED_OBJECT ("con", VariableType.OBJECT) pushed as a
// real SFS2X SetUserVariables message (RequestType.SetUserVariables = 12,
// controller 0 - a *system* packet, not a c=1/a=13 extension command).
// Confirmed from FnSetUserVariables (SmartFox2X.decompiled.cs:2757-2781):
// reads KEY_USER="u" (int) + KEY_VAR_LIST="vl" (SFSArray of per-variable
// SFSArrays), looks the user up in the client's local UserManager by that
// id, sets the variable(s), and dispatches SFSEvent.USER_VARIABLES_UPDATE,
// which is what fires GameServerEvent.DURABLE_EQUIPPED/
// DISPENSABLE_EQUIPPED (ClubPenguinClient.decompiled.cs:1793,1797) - the
// client deliberately never sets this variable itself for
// durables/dispensables, it always waits for the server's own broadcast
// (EquippedObject.FromSFSData, ClubPenguinClient.decompiled.cs:8182).
// Per-variable array shape is [name:UTF_STRING, type:BYTE(VariableType),
// value] - SFSUserVariable.ToSFSArray/BaseVariable.PopulateArrayWithValue.
//
// Found while porting from a historically-working Java SFS2X extension:
// this project's own implementation had only ever sent "con" alone. That
// extension's EquippedObjectHelper is explicit that this is wrong for
// durables/dispensables specifically - "con" and "con_prop"
// (SocketUserVars.EQUIPPED_OBJECT_PROPERTIES, a JSON *string*, not an
// SFSObject) must be set together in the SAME broadcast for the client to
// fire SERVER_ITEM_ADDED (which is what actually loads the prop prefab) -
// "con only, no con_prop" is specifically the *party-game* shape
// (EquippedObjectHelper.setPartyGame), not durables/dispensables. Value
// taken directly from the recovered source's own default
// (`EquippedObjectHelper.setEquippedObject`'s 2-arg overload):
// `{"actionCount":1}`.
export function sendEquippedObjectVariable(kind: "durable" | "dispns", nameOnServer: string, ctx: HandlerContext): void {
  // Tracked for validate.state's InWorldState.equippedItem
  // (handlers/validation.ts) - the only place on this server that reads
  // it back.
  ctx.session.equippedItemName = nameOnServer;
  // Trailing `false` on each entry is SFSUserVariable's real 4th wire
  // element (IsPrivate, SmartFox2X.decompiled.cs:9474-9522) - confirmed
  // via a real SFS2X byte capture (see handlers/sfs2x/login.ts's
  // stringVar/intVar comment); this project's variable arrays were
  // missing it everywhere until 2026-09-17.
  const conValue = new SFSObjectWriter().putUtfString("type", kind).putUtfString("name", nameOnServer);
  const conEntry = new SFSArrayWriter().putUtfString("con").putByte(VARIABLE_TYPE_OBJECT).putSFSObject(conValue).putBool(false);
  const conPropEntry = new SFSArrayWriter()
    .putUtfString("con_prop")
    .putByte(VARIABLE_TYPE_STRING)
    .putUtfString('{"actionCount":1}')
    .putBool(false);
  const varList = new SFSArrayWriter().putSFSArray(conEntry).putSFSArray(conPropEntry);
  ctx.send(encodePacket(0, 12, new SFSObjectWriter().putInt("u", ctx.session.userId).putSFSArray("vl", varList)));
  console.log(
    `[${new Date().toISOString()}] ${ctx.peer} <- set user variables (con={type:${kind},name:${nameOnServer}}, con_prop={"actionCount":1})`
  );
}

// SmartfoxCommand.EQUIP_DISPENSABLE (ClubPenguinClient.decompiled.cs:
// 7726-7727). GameServer.EquipDispensable(int id) sends {"type": id} -
// "type" genuinely is the raw int PropDefinition id here. Real SFS2X
// never turns this into a response on the same channel - the client only
// reacts via the SetUserVariables broadcast (sendEquippedObjectVariable),
// setting its own held-item state locally and unconditionally regardless
// of how we answer - so this request itself needs no ack, only the "con"
// variable push.
export function handleDispensableEquip(innerParams: SFSObjectData, ctx: HandlerContext): void {
  const propId = getInt(innerParams, "type");
  const prop = propId !== undefined ? PROP_CATALOG[propId] : undefined;
  if (prop) {
    sendEquippedObjectVariable(prop.kind, prop.nameOnServer, ctx);
  } else {
    console.log(`[${new Date().toISOString()}] ${ctx.peer} - dispensable.equip: unknown prop id ${propId}, not sending con variable`);
  }
}

// SmartfoxCommand.EQUIP_DURABLE - genuinely different payload shape from
// dispensable.equip, confirmed at ClubPenguinClient.decompiled.cs:
// 1525-1532: GameServer.EquipDurable(SignedResponse<EquipDurableResponse>
// durable) sends {"type": JsonService.Serialize(durable)} - a JSON
// *string* of the whole SignedResponse envelope, not a raw int.
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
    console.log(`[${new Date().toISOString()}] ${ctx.peer} - durable.equip: unknown prop id ${propId} (raw type=${typeJson}), not sending con variable`);
  }
}
