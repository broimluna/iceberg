// Shared SFSUserVariable list builder - extracted from handlers/sfs2x/
// login.ts's sendInitialUserVariables (see that file's own header comment
// for the full wire trace/real-capture citation behind this exact shape).
// Needed as its own module because a proximity-add packet's per-user
// "variables" field (handlers/proximity.ts) must carry this same shape -
// it's what the real client's broadcastUserVariables(item) applies to a
// freshly-spawned remote avatar (outfit/colour/etc.), not a separate
// mechanism from the standalone SetUserVariables (c=0,a=12) broadcast this
// was originally written for.

import { SFSArrayWriter } from "./sfs-wire.ts";
import type { Session } from "./session.ts";

const VARIABLE_TYPE_STRING = 4;
const VARIABLE_TYPE_INT = 2;

// [name, variableTypeByte, value, isPrivate] - SFSUserVariable's real wire
// shape (BaseVariable.PopulateArrayWithValue + FromSFSArray's
// `sfsa.GetBool(3)`, SmartFox2X.decompiled.cs:9456/9507/39947), confirmed
// via real capture: every variable entry in a real SetUserVariables
// broadcast has this trailing boolean (defaults to false/not-private).
function stringVar(name: string, value: string): SFSArrayWriter {
  return new SFSArrayWriter().putUtfString(name).putByte(VARIABLE_TYPE_STRING).putUtfString(value).putBool(false);
}
function intVar(name: string, value: number): SFSArrayWriter {
  return new SFSArrayWriter().putUtfString(name).putByte(VARIABLE_TYPE_INT).putInt(value).putBool(false);
}

export function buildUserVariablesArray(session: Session): SFSArrayWriter {
  const varList = new SFSArrayWriter().putSFSArray(stringVar("sess", session.playerSessionId ?? "0"));
  if (session.outfitJson !== undefined) varList.putSFSArray(stringVar("outfit", session.outfitJson));
  varList.putSFSArray(intVar("colour", session.colour ?? 0));
  varList.putSFSArray(intVar("tube", session.selectedTubeId ?? 0));
  varList.putSFSArray(intVar("loc", 0)); // locomotionState
  varList.putSFSArray(intVar("awayfromkeyboard", 0));
  varList.putSFSArray(intVar("tempheadstatus", 0));
  return varList;
}
