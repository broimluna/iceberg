// The login signature covers swid, sessionId, room, goodUntil and userName.
// The fields must not be re-splittable: the join route signs a room built
// from URL parts a player controls, so a "|" in it used to let one
// signature validate for a shorter room, a far-future goodUntil and a name
// the player wrote (the name check and the expiry both bypassed).
import { startWebApi, makeChecker } from "./lib/harness.ts";
import { startGameServer, GameClient, sleep } from "./lib/sfs-client.ts";
import { createPlayer } from "./lib/mix-client.ts";
import { SFSObjectWriter, encodePacket } from "../smartfox-server/src/sfs-wire.ts";

const { check, finish } = makeChecker();
const KEY = "test-join-key-" + Math.random().toString(36).slice(2);
const api = await startWebApi({ env: { ALLOW_SWID_AUTH: "1", JOIN_SIGNING_KEY: KEY } });
const gs = await startGameServer(api, KEY);

class Tamperer extends GameClient {
  joinText = "";
  edit?: (text: string) => string;
  override send(c: number, a: number, p: SFSObjectWriter) {
    if (c === 0 && a === 1 && this.edit) {
      const w = new SFSObjectWriter().putUtfString("zn", "ClubPenguin").putUtfString("un", this.username).putUtfString("pw", "")
        .putSFSObject("p", new SFSObjectWriter().putUtfString("joinRoomData", this.edit(this.joinText)));
      this.sock.write(encodePacket(0, 1, w).encode("sfs2x"));
      return;
    }
    super.send(c, a, p);
  }
  async prepare() {
    await createPlayer(this.api.base, this.api.dbPath, this.swid, this.name);
    const jr = await fetch(`${this.api.base}/game/v1/worlds/Alpine/language/en/rooms/${this.room}/players`, { method: "POST", headers: this.auth(), body: "{}" });
    this.joinText = await jr.text();
  }
}

try {
  // A normal login works.
  const normal = new Tamperer(api, gs.port, "{SIG-NORMAL}", "Normal");
  await normal.connect();
  check(normal.myId > 0, "a normal login works");

  // The player asks to join a room whose name has "|" in it.
  const evil = new Tamperer(api, gs.port, "{SIG-EVIL}", "Honest", "Town%7C99999999999999%7CEvil");
  await evil.prepare();
  const original = JSON.parse(evil.joinText);
  const pieces = String(original.data.room).split("|");
  check(pieces.length === 3, `(the signed room has the pipes in it: ${original.data.room})`);

  // The same signature, read as a shorter room, a goodUntil years away and a longer name.
  evil.edit = (t) => {
    const j = JSON.parse(t);
    const [room, until, rest] = String(j.data.room).split("|");
    const signedUntil = j.goodUntil;
    j.data.room = room;
    j.goodUntil = Number(until);
    j.data.userName = `${rest}|${signedUntil}|${j.data.userName}`;
    return JSON.stringify(j);
  };
  const forged = JSON.parse(evil.edit(evil.joinText));
  check(forged.goodUntil === 99999999999999 && forged.data.userName.startsWith("Evil::"), "(the test re-split the signed fields)");
  await evil.connect();
  await sleep(500);
  check(evil.myId < 0 && evil.closed, "the re-split login is refused");
  check(/login refused \(bad signature/.test(gs.logs()), "the server says why");

  // The unedited signature for that odd room still works for what it really says.
  const plain = new Tamperer(api, gs.port, "{SIG-EVIL}", "Honest", "Town%7C99999999999999%7CEvil");
  await plain.connect();
  check(plain.myId > 0, "the unedited login for that room is let in");
} finally {
  gs.stop();
  await api.stop();
}
finish(gs.logs());
