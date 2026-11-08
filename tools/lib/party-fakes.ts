// In-process fake players for party-game tests: registered sessions whose
// send() decodes every packet into extension responses (1/13) and user
// variable updates (0/12).
import { tryReadHeader, decodeSFSObject, SFSDataType, type OutgoingPacket, type SFSObjectData, type SFSValue } from "../../smartfox-server/src/sfs-wire.ts";
import { register, type RegisteredSession } from "../../smartfox-server/src/session-registry.ts";
import { Session } from "../../smartfox-server/src/session.ts";

export interface FakePlayer {
  entry: RegisteredSession;
  session: Session;
  sid: string;
  ext: { cmd: string; p: SFSObjectData }[];
  vars: { u: number; vars: Record<string, unknown> }[];
  clear(): void;
  extOf(cmd: string): SFSObjectData[];
  // pgame.message bodies as {type, json}.
  messages(): { type: number; json: any }[];
}

let nextSid = 1059482726353499000n;

export function decodeVars(vl: SFSValue[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const v of vl) {
    const e = v.value as SFSValue[];
    const val = e[2]!;
    out[e[0]!.value as string] = val.type === SFSDataType.NULL ? null
      : val.type === SFSDataType.SFS_OBJECT ? `${(val.value as SFSObjectData).type?.value}:${(val.value as SFSObjectData).name?.value}`
      : val.value;
  }
  return out;
}

export function makePlayer(name: string, room: string): FakePlayer {
  const session = new Session();
  session.roomName = room;
  session.userName = name;
  const sid = String(nextSid++);
  session.playerSessionId = sid;
  const fake: FakePlayer = {
    session, sid, ext: [], vars: [],
    entry: undefined as unknown as RegisteredSession,
    clear() { fake.ext = []; fake.vars = []; },
    extOf(cmd) { return fake.ext.filter((e) => e.cmd === cmd).map((e) => e.p); },
    messages() {
      return fake.extOf("pgame.message").map((p) => ({ type: p.type!.value as number, json: JSON.parse(p.message!.value as string) }));
    },
  };
  const send = (packet: OutgoingPacket) => {
    const buf = packet.encode("sfs2x");
    const h = tryReadHeader(buf, "sfs2x")!;
    const env = decodeSFSObject(buf.subarray(h.headerLength, h.totalLength), 0, "sfs2x").value;
    const c = env.c?.value as number, a = env.a?.value as number;
    const p = (env.p?.type === SFSDataType.SFS_OBJECT ? env.p.value : {}) as SFSObjectData;
    if (c === 1 && a === 13) fake.ext.push({ cmd: p.c?.value as string, p: (p.p?.value ?? {}) as SFSObjectData });
    else if (c === 0 && a === 12) fake.vars.push({ u: p.u!.value as number, vars: decodeVars(p.vl!.value as SFSValue[]) });
  };
  fake.entry = { session, peer: name, send };
  register(fake.entry);
  return fake;
}
