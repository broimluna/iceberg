// quest.c_obj keeps the active quest's completed objectives per session
// and replies with the whole list (quest.s_obj). The list is bounded: real
// quests have at most 11 objectives with short names, so names over 64
// bytes and objectives past 64 are ignored, from quest.c_obj and from the
// client's quest.set alike.
import { startWebApi, makeChecker } from "./lib/harness.ts";
import { startGameServer, GameClient, sleep } from "./lib/sfs-client.ts";
import { SFSObjectWriter } from "../smartfox-server/src/sfs-wire.ts";
import { getUtfString } from "../smartfox-server/src/wire-helpers.ts";

const { check, finish } = makeChecker();
const KEY = "test-join-key-" + Math.random().toString(36).slice(2);
const api = await startWebApi({ env: { ALLOW_SWID_AUTH: "1", JOIN_SIGNING_KEY: KEY } });
const sfs = await startGameServer(api, KEY, { SFS_MAX_PACKETS_PER_SEC: "0" });

const lastList = (c: GameClient): string[] => {
  const replies = c.extOf("quest.s_obj");
  const data = replies.length ? getUtfString(replies[replies.length - 1]!, "data") : undefined;
  return data ? JSON.parse(data).data : [];
};

try {
  const c = new GameClient(api, sfs.port, "{quest-obj}", "QuestCapper");
  await c.connect();
  const complete = (obj: string) => c.ext13("quest.c_obj", new SFSObjectWriter().putUtfString("obj", obj));

  complete("Obj0FSM");
  await sleep(200);
  check(lastList(c).join() === "Obj0FSM", `a normal objective is recorded (${lastList(c)})`);

  complete("x".repeat(5000));
  await sleep(200);
  check(lastList(c).length === 1, "an objective name over 64 bytes is ignored");

  for (let i = 0; i < 200; i++) complete(`Fake${i}`);
  await sleep(800);
  check(lastList(c).length === 64, `at most 64 objectives are kept (${lastList(c).length})`);

  // quest.set seeds the list from the client; the same bounds apply.
  const many = Array.from({ length: 500 }, (_, i) => `Seed${i}`).concat(["y".repeat(5000)]);
  c.ext13("quest.set", new SFSObjectWriter().putUtfString("data", JSON.stringify({ data: [{ status: 1, completedObjectives: many }] })));
  await sleep(200);
  c.clear();
  complete("Obj1FSM");
  await sleep(300);
  const seeded = lastList(c);
  check(seeded.length <= 64 && seeded.every((o) => o.length <= 64), `quest.set is bounded too (${seeded.length} kept)`);
} finally {
  sfs.stop();
  await api.stop();
}
finish(sfs.logs());
