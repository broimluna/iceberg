// Staff chat commands end to end: a web API, a game server and fake
// clients that log in with real signed joinRoomData.
//   bun tools/staff-commands-test.ts [section ...]   (default: all)
import { makeChecker } from "./lib/harness.ts";
import { startServers, Client, sleep, owns, coins, type Servers } from "./lib/staff-client.ts";

const { check, finish } = makeChecker();
const wanted = process.argv.slice(2);
const run = (name: string) => wanted.length === 0 || wanted.includes(name);
const until = async (cond: () => boolean, ms = 2000) => { for (let t = 0; t < ms && !cond(); t += 20) await sleep(20); return cond(); };

const servers: Servers = await startServers();
const logs = () => servers.api.logs() + "\n" + servers.sfsLog();

// Accounts shared by the sections. root, root2 and dave are config admins;
// bob is promoted to moderator by the moderation section.
const root = new Client(servers, "{st-root}", "Root");
const root2 = new Client(servers, "{st-root2}", "Root2");
const bob = new Client(servers, "{st-bob}", "Bob");
const carol = new Client(servers, "{st-carol}", "Carol");
const dave = new Client(servers, "{st-dave}", "Dave");
for (const c of [root, root2, bob, carol, dave]) await c.account();
await servers.setStaffAdmins([root.username, root2.username, dave.username]);
const everyone = [root, root2, bob, carol, dave];
const disconnectAll = async () => { for (const c of everyone) if (c.sock && !c.closed) c.disconnect(); await sleep(150); };
const setRoleVia = (c: Client, role: string) => fetch(`${servers.api.base}/api/internal/set-role`, {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: c.username, role }),
});
const SAY = async (c: Client, text: string, wait = 300) => { for (const x of everyone) x.reset(); c.chat(text); await sleep(wait); };

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

  if (run("framework")) {
    await root.connect(); await bob.connect(); await carol.connect();
    await SAY(root, ":help");
    const help = root.bubbles.join("\n");
    check([":online", ":find", ":help"].every((c) => help.includes(c)), `:help lists the commands (${JSON.stringify(help).slice(0, 200)})`);
    check(bob.ext.length === 0 && carol.ext.length === 0, "nobody else receives the command or its reply");
    await SAY(root, ":online");
    check(root.bubbles.some((b) => b.includes("3 online") && b.includes(bob.username)), `:online (${root.bubbles})`);
    await SAY(root, `:find ${bob.username.toUpperCase()}`);
    check(root.bubbles.some((b) => b.includes(bob.username) && b.includes("Town")), `:find, any case (${root.bubbles})`);
    await SAY(root, ":find ghost");
    check(root.errors.includes("ghost isn't online"), `:find someone offline (${root.errors})`);
    await SAY(root, ":nosuch");
    check(root.errors.includes("Unknown command") && carol.roomChats.length === 0, `unknown staff command (${root.errors})`);
    await SAY(root, ":)");
    check(carol.roomChats.includes(":)") && root.bubbles.length + root.errors.length === 0, "a staff member's :) is chat");
    await SAY(root, ":D hi");
    check(carol.roomChats.includes(":D hi"), "a staff member's :D is chat");
    await SAY(bob, ":online");
    check(carol.roomChats.includes(":online") && bob.bubbles.length + bob.errors.length === 0, "a player's :online is plain chat");
    await SAY(bob, ":ac 500");
    check(carol.roomChats.includes(":ac 500") && bob.bubbles.length + bob.errors.length === 0, "a player's :ac is plain chat");
    // (A command sent before the role is known is covered by staff-unit-test.ts.)
    await dave.connect();
    await SAY(dave, ":online");
    check(dave.bubbles.some((b) => b.includes("online")), "the same command works once the role is known");
    await disconnectAll();
  }

  if (run("moderation")) {
    await setRoleVia(bob, "moderator");
    await root.connect(); await bob.connect(); await carol.connect(); await dave.connect();
    await SAY(bob, `:kick ${carol.username}`);
    await until(() => carol.closed);
    check(carol.kickReason === 1 && carol.closed, `kicked player gets reason 1 and is disconnected (${carol.kickReason}, ${carol.closed})`);
    check(bob.bubbles.includes(`Kicked ${carol.username}`), `kick is confirmed (${bob.bubbles})`);
    await SAY(bob, `:kick ${root.username}`);
    check(bob.errors.includes(`You can't kick ${root.username}`) && !root.closed, `a moderator can't kick an admin (${bob.errors})`);
    await SAY(bob, `:kick ${bob.username}`);
    check(bob.errors.includes("You can't kick yourself") && !bob.closed, `nobody can kick themselves (${bob.errors})`);

    await carol.connect();
    await SAY(bob, `:mute ${carol.username} 5`);
    check(bob.bubbles.some((b) => b.includes(`Muted ${carol.username}`)), `mute is confirmed (${bob.bubbles})`);
    check(carol.errors.some((e) => e.includes("muted")), `the muted player is told (${carol.errors})`);
    await SAY(carol, "hello?");
    check(!dave.roomChats.includes("hello?") && carol.errors.some((e) => e.includes("muted")), `muted chat isn't relayed (${carol.errors})`);
    carol.disconnect(); await sleep(150); await carol.connect();
    await SAY(carol, "still here");
    check(!dave.roomChats.includes("still here"), "a mute survives reconnecting");
    for (const bad of ["0", "1441", "abc", "1.5"]) {
      await SAY(bob, `:mute ${dave.username} ${bad}`);
      check(bob.errors.some((e) => e.startsWith("Usage:")), `:mute with ${bad} minutes is refused (${bob.errors})`);
    }
    await SAY(dave, "dave talks");
    check(carol.roomChats.includes("dave talks"), "a refused mute mutes nobody");
    await SAY(bob, `:mute ${root.username}`);
    check(bob.errors.includes(`You can't mute ${root.username}`), `a moderator can't mute an admin (${bob.errors})`);
    await SAY(bob, `:unmute ${carol.username}`);
    check(bob.bubbles.includes(`Unmuted ${carol.username}`), `unmute is confirmed (${bob.bubbles})`);
    await SAY(carol, "back");
    check(dave.roomChats.includes("back"), "unmuted chat is relayed");
    await SAY(bob, `:unmute ${carol.username}`);
    check(bob.errors.includes(`${carol.username} isn't muted`), `unmuting twice (${bob.errors})`);
    await disconnectAll();
  }

  if (run("economy")) {
    await setRoleVia(bob, "moderator");
    await root.connect(); await bob.connect(); await carol.connect();
    const pushed = (c: Client) => c.ext.filter((e) => e.cmd === "reward.add").map((e) => JSON.parse(e.p.reward!.value as string).data.rewards[c.sid]);
    const before = coins(servers.api.dbPath, root.username)!;
    await SAY(root, ":ac 500");
    check(coins(servers.api.dbPath, root.username) === before + 500, `:ac adds coins in the web API (${before} -> ${coins(servers.api.dbPath, root.username)})`);
    check(pushed(root).some((r) => r?.coins === 500), `the client gets reward.add for its own sessionId (${JSON.stringify(pushed(root))})`);
    check(root.bubbles.includes(`Gave 500 coins to ${root.username}`), `confirmed (${root.bubbles})`);
    const carolBefore = coins(servers.api.dbPath, carol.username)!;
    await SAY(root, `:ac 250 ${carol.username.toUpperCase()}`);
    check(coins(servers.api.dbPath, carol.username) === carolBefore + 250 && pushed(carol).some((r) => r?.coins === 250), "coins for another player go to them");
    check(pushed(root).length === 0, "and not to the admin");
    for (const bad of ["-5", "0", "1e9", "abc", "1000001", "2.5"]) {
      const was = coins(servers.api.dbPath, root.username);
      await SAY(root, `:ac ${bad}`);
      check(root.errors.some((e) => e.startsWith("Usage:")) && coins(servers.api.dbPath, root.username) === was && pushed(root).length === 0, `:ac ${bad} is refused`);
    }
    await SAY(root, ":ac 5 ghost");
    check(root.errors.includes("ghost isn't online"), `:ac for someone offline (${root.errors})`);
    await SAY(root, ":ai durable 77");
    check(owns(servers.api.dbPath, "owned_durables", "durable_id", root.username, 77) && pushed(root).some((r) => r?.durables?.includes(77)), ":ai durable");
    await SAY(root, `:ai tube 3 ${carol.username}`);
    check(pushed(carol).some((r) => r?.tubes?.includes(3)), ":ai tube for another player");
    await SAY(root, ":ai hat 3");
    check(root.errors.some((e) => e.startsWith("Usage:") && e.includes("equipment")), `unknown item type lists the types (${root.errors})`);
    await SAY(root, ":ai durable x");
    check(root.errors.some((e) => e.startsWith("Usage:")), "non-numeric item id is refused");
    await SAY(bob, ":ac 5");
    check(bob.errors.includes("Unknown command"), `a moderator can't give coins (${bob.errors})`);
    // The web API is down: nothing is pushed for a grant that wasn't saved.
    await servers.api.stop();
    await SAY(root, ":ac 5", 600);
    check(root.errors.includes("Couldn't save the reward") && pushed(root).length === 0, `failed grant (${root.errors})`);
    await servers.setStaffAdmins([root.username, root2.username, dave.username]);
    await disconnectAll();
  }

  if (run("unsigned")) {
    // SFS_ALLOW_UNSIGNED_LOGIN (development) accepts the login and credits
    // the account, but never grants a staff role.
    const dev = await startServers({ sfsEnv: { SFS_ALLOW_UNSIGNED_LOGIN: "1" } });
    try {
      const admin = new Client(dev, "{dev-admin}", "DevAdmin"), watcher = new Client(dev, "{dev-watcher}", "DevWatcher");
      await admin.account(); await watcher.account();
      await dev.setStaffAdmins([admin.username]);
      await admin.connect({ unsigned: true }); await watcher.connect();
      check(!admin.closed, "unsigned login accepted in development mode");
      admin.reset(); watcher.reset();
      admin.chat(":online");
      await sleep(300);
      check(watcher.roomChats.includes(":online") && admin.bubbles.length === 0, "an unsigned config admin's :online is plain chat");
      check(dev.sfsLog().includes(`-> ${admin.username} (role ignored: unsigned)`), "the log says the role was ignored");
    } finally {
      await dev.stop();
    }
  }
} finally {
  await servers.stop();
}
if (process.env.DEBUG_LOGS) console.log(logs());
finish(logs());
