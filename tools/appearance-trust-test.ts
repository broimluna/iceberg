// What other players see of someone (colour, tube, outfit) is what the web
// API has saved for the account, not what the client says. The client
// relays these itself (joinRoomData at login, user variables afterwards),
// so the game server asks the web API and shows the saved values:
// - an honest login causes no corrections;
// - a login whose joinRoomData was edited is corrected to the saved values;
// - variables a client sets are never relayed as sent, but a real change
//   (saved with the web API first, as the client does) is relayed;
// - the web API's record only contains items the account owns.
import { startWebApi, makeChecker } from "./lib/harness.ts";
import { startGameServer, GameClient, sleep } from "./lib/sfs-client.ts";
import { createPlayer } from "./lib/mix-client.ts";
import { SFSObjectWriter, SFSArrayWriter } from "../smartfox-server/src/sfs-wire.ts";
import tubes from "../web-api/data/tubes.json";

const { check, finish } = makeChecker();
const KEY = "test-join-key-" + Math.random().toString(36).slice(2);
const api = await startWebApi({ env: { ALLOW_SWID_AUTH: "1", JOIN_SIGNING_KEY: KEY } });
const gs = await startGameServer(api, KEY);

// Logs in with a copy of joinRoomData that a test can edit first.
class Tamperer extends GameClient {
  joinText = "";
  edit?: (text: string) => string;
  override send(c: number, a: number, p: SFSObjectWriter) {
    if (c === 0 && a === 1 && this.edit) {
      this.sock.write(this.encodeLogin(this.edit(this.joinText)));
      return;
    }
    super.send(c, a, p);
  }
  encodeLogin(joinText: string): Buffer {
    const w = new SFSObjectWriter().putUtfString("zn", "ClubPenguin").putUtfString("un", this.username).putUtfString("pw", "")
      .putSFSObject("p", new SFSObjectWriter().putUtfString("joinRoomData", joinText));
    return encodeLoginPacket(w);
  }
  async prepare() {
    await createPlayer(this.api.base, this.api.dbPath, this.swid, this.name);
    const jr = await fetch(`${this.api.base}/game/v1/worlds/Alpine/language/en/rooms/Town/players`, { method: "POST", headers: this.auth(), body: "{}" });
    this.joinText = await jr.text();
  }
}
import { encodePacket } from "../smartfox-server/src/sfs-wire.ts";
const encodeLoginPacket = (w: SFSObjectWriter) => encodePacket(0, 1, w).encode("sfs2x");

const stringVar = (name: string, value: string) => new SFSObjectWriter().putSFSArray("vl", new SFSArrayWriter().putSFSArray(
  new SFSArrayWriter().putUtfString(name).putVariableType("string").putUtfString(value).putBool(false)));
const web = (c: GameClient, method: string, path: string, body?: unknown) =>
  fetch(`${api.base}${path}`, { method, headers: c.auth(), body: body === undefined ? undefined : JSON.stringify(body) }).then((r) => r.json());

try {
  const watcher = new Tamperer(api, gs.port, "{LOOK-WATCHER}", "Watcher");
  await watcher.connect();

  // ---- an honest login causes no corrections ----
  const honest = new Tamperer(api, gs.port, "{LOOK-HONEST}", "HonestOne");
  await honest.connect();
  await sleep(500);
  check(honest.myId > 0, "an honest login works");
  check(watcher.varsOf(honest.myId).length === 0, `and nobody is sent a correction (${JSON.stringify(watcher.varsOf(honest.myId))})`);

  // ---- a login whose joinRoomData was edited ----
  const forger = new Tamperer(api, gs.port, "{LOOK-FORGER}", "ForgerOne");
  await forger.prepare();
  const colourBefore = forger.joinText.match(/"colour":(\d+)/)?.[1];
  check(!!colourBefore, `(joinRoomData carries a colour: ${colourBefore})`);
  forger.edit = (t) => t.replace(/"colour":\d+/, '"colour":16711680')
    .replace(/"selectedTubeId":\d+/, '"selectedTubeId":4')
    .replace(/("outfit":\{"parts":)\[\]/, '$1[{"equipmentId":123456,"dateTimeCreated":1,"definitionId":9999,"parts":[1,2]}]');
  check(forger.edit(forger.joinText) !== forger.joinText, "(the test edited colour, tube and outfit)");
  check(forger.edit(forger.joinText).includes('"definitionId":9999'), "(including a worn item the account doesn't own)");
  await forger.connect();
  await sleep(600);
  check(forger.myId > 0, "the edited login is let in (those fields aren't signed)");
  const fixes = watcher.varsOf(forger.myId);
  check(fixes.some((v) => v.colour === Number(colourBefore)), `the room is sent the saved colour (${JSON.stringify(fixes.map((v) => v.colour))})`);
  check(fixes.some((v) => v.tube === 0), "and the saved tube");
  check(fixes.some((v) => typeof v.outfit === "string" && !v.outfit.includes("9999")), "and an outfit without the item it doesn't own");
  check(forger.varsOf(forger.myId).length > 0, "the player is sent the corrections too");
  check(/set to the saved value \(login\)/.test(gs.logs()), "the server logs the correction");

  // ---- variables set later are not relayed as sent ----
  watcher.clear();
  forger.send(0, 12, stringVar("colour", JSON.stringify({ goodUntil: 1, swid: forger.swid, data: { colour: 255 }, signature: "x" })));
  forger.send(0, 12, stringVar("tube", JSON.stringify({ goodUntil: 1, swid: forger.swid, data: { tubeId: 3 }, signature: "x" })));
  forger.send(0, 12, stringVar("outfit", JSON.stringify({ goodUntil: 1, swid: forger.swid, data: { parts: [{ equipmentId: 7, dateTimeCreated: 1, definitionId: 9999, parts: [] }], sessionId: 1 }, signature: "x" })));
  await sleep(500);
  const forged = watcher.varsOf(forger.myId);
  check(forged.length === 0, `colour, tube and outfit the web API doesn't have are not relayed (${JSON.stringify(forged)})`);

  // ---- a real change: saved with the web API, then set as a variable ----
  const made = await web(forger, "POST", "/inventory/v1/equipment", { definitionId: 1 });
  const equipmentId = made?.equipmentId ?? made?.data?.equipmentId;
  check(Number.isInteger(equipmentId), `(the account made a clothing item: ${JSON.stringify(made).slice(0, 80)})`);
  const saved = await web(forger, "POST", "/player/v1/outfit", { parts: [equipmentId] });
  const profile = await web(forger, "POST", "/player/v1/profile", { colour: 255 });
  const tubeId = (tubes as { ids: number[] }).ids.find((id) => id !== 0)!;
  const equipped = await web(forger, "PUT", `/tube/v1/equip/${tubeId}`);
  watcher.clear();
  forger.send(0, 12, stringVar("colour", JSON.stringify(profile)));
  forger.send(0, 12, stringVar("tube", JSON.stringify(equipped)));
  forger.send(0, 12, stringVar("outfit", JSON.stringify(saved)));
  await sleep(600);
  const real = watcher.varsOf(forger.myId);
  check(real.some((v) => v.colour === 255), `a saved colour change is relayed (${JSON.stringify(real.map((v) => v.colour))})`);
  check(real.some((v) => v.tube === tubeId), `a saved tube change is relayed (${JSON.stringify(real.map((v) => v.tube))})`);
  const outfit = real.map((v) => v.outfit).find((o) => typeof o === "string") as string | undefined;
  check(!!outfit && JSON.parse(outfit).parts.length === 1 && JSON.parse(outfit).parts[0].equipmentId === equipmentId, `a saved outfit change is relayed (${outfit})`);
  check(!!outfit && /"sessionId":\d+/.test(outfit), "with a session id, like the outfits clients send");

  // ---- customizations on a worn item ----
  const custom = new Tamperer(api, gs.port, "{LOOK-CUSTOM}", "CustomOne");
  await createPlayer(api.base, api.dbPath, custom.swid, custom.name);
  const parts = [{ slotIndex: 0, customizations: [{ index: 1, definitionId: 5 }] }];
  const item = await web(custom, "POST", "/inventory/v1/equipment", { definitionId: 1, parts });
  await web(custom, "POST", "/player/v1/outfit", { parts: [item.equipmentId] });
  // A client's re-serialization: other key order, another timestamp, extra null fields.
  const reserialized = (t: string) => {
    const j = JSON.parse(t);
    j.data.playerRoomData.outfit.parts = j.data.playerRoomData.outfit.parts.map((p: any) => ({
      parts: p.parts.map((x: any) => ({ customizations: x.customizations.map((c: any) => ({ definitionId: c.definitionId, index: c.index, extra: null })), slotIndex: x.slotIndex })),
      definitionId: p.definitionId, dateTimeCreated: p.dateTimeCreated + 5, equipmentId: p.equipmentId, note: null,
    }));
    return JSON.stringify(j);
  };
  await custom.prepare();
  check(JSON.parse(custom.joinText).data.playerRoomData.outfit.parts.length === 1, "(the join carries the worn, customized item)");
  custom.edit = reserialized;
  watcher.clear();
  await custom.connect();
  await sleep(500);
  check(custom.myId > 0 && watcher.varsOf(custom.myId).length === 0, `a differently serialized but identical outfit causes no correction (${JSON.stringify(watcher.varsOf(custom.myId)).slice(0, 80)})`);

  const swapper = new Tamperer(api, gs.port, "{LOOK-CUSTOM}", "CustomOne");
  await swapper.prepare();
  swapper.edit = (t) => reserialized(t).replace('"definitionId":5', '"definitionId":6');
  check(swapper.edit(swapper.joinText).includes('"definitionId":6'), "(the test swapped a customization on the worn item)");
  watcher.clear();
  await swapper.connect();
  await sleep(500);
  const swapped = watcher.varsOf(swapper.myId);
  check(swapped.some((v) => typeof v.outfit === "string" && v.outfit.includes('"definitionId":5')), `a swapped customization is corrected (${JSON.stringify(swapped).slice(0, 100)})`);

  // ---- the saved outfit only holds items the account owns ----
  const sneaky = await web(forger, "POST", "/player/v1/outfit", { parts: [equipmentId, 424242] });
  check(sneaky?.data?.parts?.length === 1 && sneaky.data.parts[0].equipmentId === equipmentId, "saving an outfit with an id the account doesn't own leaves it out");
  const other = new Tamperer(api, gs.port, "{LOOK-OTHER}", "OtherOne");
  await other.connect();
  const others = await web(other, "POST", "/player/v1/outfit", { parts: [equipmentId] });
  check(others?.data?.parts?.length === 0, "and another account can't wear that item");

  // ---- setting the same values again changes nothing ----
  watcher.clear();
  forger.send(0, 12, stringVar("colour", JSON.stringify(profile)));
  await sleep(400);
  check(watcher.varsOf(forger.myId).length === 0, "setting the saved colour again sends nothing");

  // ---- a null variable still works as before ----
  check(!forger.closed && !watcher.closed, "nobody was disconnected");
} finally {
  gs.stop();
  await api.stop();
}
finish(gs.logs());
