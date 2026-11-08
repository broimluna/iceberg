// Staff chat commands end to end: a web API, a game server and fake
// clients that log in with real signed joinRoomData.
//   bun tools/staff-commands-test.ts [section ...]   (default: all)
import { makeChecker } from "./lib/harness.ts";
import { startServers, Client, sleep, owns, type Servers } from "./lib/staff-client.ts";

const { check, finish } = makeChecker();
const wanted = process.argv.slice(2);
const run = (name: string) => wanted.length === 0 || wanted.includes(name);
const until = async (cond: () => boolean, ms = 2000) => { for (let t = 0; t < ms && !cond(); t += 20) await sleep(20); return cond(); };

const servers: Servers = await startServers();
const logs = () => servers.api.logs() + "\n" + servers.sfsLog();

try {
  if (run("identity")) {
    // The login name ("un") isn't signed: rewards go to the account behind
    // the signed swid, whatever name the client claims.
    const alice = new Client(servers, "{id-alice}", "IdAlice");
    const bob = new Client(servers, "{id-bob}", "IdBob");
    await bob.account();
    await alice.connect({ loginName: bob.username, waitIdentity: false });
    alice.questSet(); // first quest.set sends the starter pack, right after login
    const granted = (u: string) => servers.api.logs().includes(`Granted reward to ${u} `);
    await until(() => granted(alice.username) || granted(bob.username));
    check(granted(alice.username), "starter pack goes to the signed account");
    check(!granted(bob.username), "not to the account named in \"un\"");
    alice.disconnect();
  }
} finally {
  await servers.stop();
}
if (process.env.DEBUG_LOGS) console.log(logs());
finish(logs());
