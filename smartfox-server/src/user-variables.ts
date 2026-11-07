// Builds a player's SFS user-variable list (session, outfit, colour, tube,
// etc.). Used both at login and in proximity "user added" packets, which is
// how a remote avatar gets its outfit when it spawns.

import { SFSArrayWriter, SFSObjectWriter } from "./sfs-wire.ts";
import type { Session } from "./session.ts";

// Wire shape of one variable: [name, typeByte, value, isPrivate]. The type
// byte is numbered per protocol (putVariableType).
function stringVar(name: string, value: string): SFSArrayWriter {
  return new SFSArrayWriter().putUtfString(name).putVariableType("string").putUtfString(value).putBool(false);
}
function intVar(name: string, value: number): SFSArrayWriter {
  return new SFSArrayWriter().putUtfString(name).putVariableType("int").putInt(value).putBool(false);
}

export function buildUserVariablesArray(session: Session): SFSArrayWriter {
  const varList = new SFSArrayWriter().putSFSArray(stringVar("sess", session.playerSessionId ?? "0"));
  if (session.outfitJson !== undefined) varList.putSFSArray(stringVar("outfit", session.outfitJson));
  varList.putSFSArray(intVar("colour", session.colour ?? 0));
  varList.putSFSArray(intVar("tube", session.selectedTubeId ?? 0));
  varList.putSFSArray(intVar("loc", 0)); // locomotionState
  varList.putSFSArray(intVar("awayfromkeyboard", 0));
  varList.putSFSArray(intVar("tempheadstatus", 0));
  // A held consumable, so others see it in the player's hand.
  if (session.equippedConsumable) {
    const con = new SFSObjectWriter().putUtfString("type", "consum").putUtfString("name", session.equippedConsumable);
    varList.putSFSArray(new SFSArrayWriter().putUtfString("con").putVariableType("object").putSFSObject(con).putBool(false));
    // A held tray or taken item ("con" + "con_prop" makes a PlayerHeldItem).
    if (session.heldActionCount !== undefined) {
      varList.putSFSArray(stringVar("con_prop", `{"actionCount":${session.heldActionCount}}`));
    }
  }
  return varList;
}
