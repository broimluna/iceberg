// One game connection per account: a second login with the same swid closes
// the first (the newest wins), other accounts are untouched, and the
// account stays online and in its room afterwards.
import { startWebApi, makeChecker } from "./lib/harness.ts";
import { startGameServer, GameClient, sleep } from "./lib/sfs-client.ts";

const { check, finish } = makeChecker();
const KEY = "test-join-key-" + Math.random().toString(36).slice(2);
const api = await startWebApi({ env: { ALLOW_SWID_AUTH: "1", JOIN_SIGNING_KEY: KEY } });
const gs = await startGameServer(api, KEY);
const clients: GameClient[] = [];
const join = async (swid: string, name: string) => { const c = new GameClient(api, gs.port, swid, name); clients.push(c); await c.connect(); return c; };

try {
  const watcher = await join("{one-w}", "Watcher");
  const first = await join("{one-a}", "PlayerOne");
  check(first.myId >= 0 && !first.closed, "the first connection is logged in");

  const second = await join("{one-a}", "PlayerOne");
  for (let i = 0; i < 30 && !first.closed; i++) await sleep(100);
  check(second.myId >= 0, "the second login succeeds");
  check(first.closed, "and the older connection of the same account is closed");
  check(!second.closed, "the newer connection stays open");
  check(!watcher.closed, "other accounts are not touched");
  check(/logged in again, closing the older connection/.test(gs.logs()), "the server logs it");

  // The older connection's cleanup must not take the account offline or out of the room.
  await sleep(500);
  const online = await fetch(`${api.base}/player/v1/id/online`, {
    method: "POST", headers: watcher.auth(), body: JSON.stringify(["{one-a}"]),
  }).then((r) => r.json());
  check(Array.isArray(online) && online.includes("{one-a}"), `the account is still shown online (${JSON.stringify(online)})`);
  watcher.clear();
  second.setCon(null);
  await sleep(300);
  check(!second.closed, "the newer connection still works after the older one's cleanup");

  // A third login replaces the second, and a different account logging in does not close anyone.
  const other = await join("{one-b}", "PlayerTwo");
  await sleep(300);
  check(!other.closed && !second.closed && !watcher.closed, "a different account logging in closes nobody");
  const third = await join("{one-a}", "PlayerOne");
  for (let i = 0; i < 30 && !second.closed; i++) await sleep(100);
  check(second.closed && !third.closed && !other.closed, "a third login replaces the second only");
} finally {
  for (const c of clients) c.sock?.destroy();
  gs.stop();
  await api.stop();
}
finish(api.logs());
