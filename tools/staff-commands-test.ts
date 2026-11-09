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
  method: "POST", headers: servers.api.internalHeaders(), body: JSON.stringify({ username: c.username, role }),
});
const SAY = async (c: Client, text: string, wait = 300) => { for (const x of everyone) x.reset(); await c.chat(text); await sleep(wait); };

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
    // Players can't dress their chat up as a system message.
    await SAY(bob, "\u200B\u200CModerator notice: you won");
    check(carol.roomChats.includes("Moderator notice: you won") && !carol.roomChats.some((m) => /^[\u200B-\u200D\u2060\uFEFF]/.test(m)),
      `a player's system prefix is stripped (${JSON.stringify(carol.roomChats)})`);
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

    // A mute holds against the muted person and anyone ranked below whoever set it.
    await SAY(root, `:mute ${bob.username} 5`);
    await SAY(bob, `:unmute ${bob.username}`);
    check(bob.errors.includes("You can't unmute yourself"), `no unmuting yourself (${bob.errors})`);
    await setRoleVia(carol, "moderator");
    carol.disconnect(); await sleep(150); await carol.connect();
    await SAY(carol, `:unmute ${bob.username}`);
    check(carol.errors.includes(`${bob.username} was muted by an admin`), `a moderator can't lift an admin's mute (${carol.errors})`);
    await root2.connect();
    await SAY(root2, `:unmute ${bob.username}`);
    check(root2.bubbles.includes(`Unmuted ${bob.username}`), `another admin can (${root2.bubbles})`);
    await setRoleVia(carol, "player");

    // Accounts whose names differ only in case are different accounts.
    const twinA = new Client(servers, "{st-twin}", "TwinA"), twinB = new Client(servers, "{ST-TWIN}", "TwinB");
    everyone.push(twinA, twinB);
    await twinA.connect(); await twinB.connect();
    check(twinA.username !== twinB.username && twinA.username.toLowerCase() === twinB.username.toLowerCase(), `test setup: look-alike names (${twinA.username}, ${twinB.username})`);
    await SAY(root, `:mute ${twinA.username} 5`);
    await SAY(twinB, "twin b talks");
    check(dave.roomChats.includes("twin b talks"), "muting one account doesn't mute a look-alike");
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
    // (The command was signed just before, as chat needs the web API too.)
    const preSigned = (await root.signChat(":ac 5"))!;
    await servers.api.stop();
    for (const x of everyone) x.reset();
    root.sendChatJson(preSigned);
    await sleep(600);
    check(root.errors.includes("Couldn't save the reward") && pushed(root).length === 0, `failed grant (${root.errors})`);
    await servers.setStaffAdmins([root.username, root2.username, dave.username]);
    await disconnectAll();
  }

  if (run("announce")) {
    await root.connect(); await bob.connect(); await carol.connect();
    const alerts = (c: Client) => c.ext.filter((e) => e.cmd === "server.alert").map((e) => e.p.message!.value as string);
    await SAY(root, ":announce Party at the dock!");
    check([root, bob, carol].every((c) => alerts(c).includes("Party at the dock!")), "every player gets the server.alert popup");
    check([root, bob, carol].every((c) => c.bubbles.includes("Party at the dock!")), "SFS2X players also get the bubble");
    // Chat is capped at 200 characters, so that's the longest announcement.
    await SAY(root, ":announce " + "x".repeat(190));
    check(alerts(carol)[0]?.length === 190, `a long announcement arrives whole (${alerts(carol)[0]?.length})`);
    await SAY(root, ":restart 600");
    check(root.bubbles.some((b) => b.includes("not supervised")), `without the supervisor the admin is warned (${root.bubbles})`);
    await SAY(root, ":restart cancel");
    await SAY(root, ":announce");
    check(root.errors.some((e) => e.startsWith("Usage:")) && alerts(carol).length === 0, "an empty announcement is refused");
    await setRoleVia(bob, "moderator");
    bob.disconnect(); await sleep(150); await bob.connect();
    await SAY(bob, ":announce hi");
    check(bob.errors.includes("Unknown command") && alerts(carol).length === 0, "a moderator can't announce");
    await disconnectAll();
  }

  if (run("restart")) {
    // :restart stops the process, so it gets its own servers under the supervisor.
    const sup = await startServers({ sfsEntry: "src/supervisor.ts" });
    try {
      const admin = new Client(sup, "{rs-admin}", "RsAdmin"), mod = new Client(sup, "{rs-mod}", "RsMod"), player = new Client(sup, "{rs-player}", "RsPlayer");
      for (const c of [admin, mod, player]) await c.account();
      await sup.setStaffAdmins([admin.username]);
      await fetch(`${sup.api.base}/api/internal/set-role`, { method: "POST", headers: sup.api.internalHeaders(), body: JSON.stringify({ username: mod.username, role: "moderator" }) });
      await admin.connect(); await mod.connect(); await player.connect();
      const say = async (c: Client, text: string, wait = 300) => { for (const x of [admin, mod, player]) x.reset(); await c.chat(text); await sleep(wait); };
      const notices = (c: Client) => c.ext.filter((e) => e.cmd === "server.restarting" || e.cmd === "server.alert").map((e) => `${e.cmd}:${e.p.message!.value}`);
      // Over a day is refused: a timer that long overflows and would fire at once.
      for (const bad of ["0", "-1", "1.5", "soon", "86401", "3000000"]) {
        await say(admin, `:restart ${bad}`);
        check(admin.errors.some((e) => e.startsWith("Usage:")) && notices(player).length === 0, `:restart ${bad} is refused`);
      }
      await say(mod, ":restart 5");
      check(mod.errors.includes("Unknown command") && notices(player).length === 0, "a moderator can't restart");
      await say(admin, ":restart 65");
      check(notices(player)[0] === "server.restarting:GlobalUI.ErrorMessages.ServerRestarting", `the countdown starts with server.restarting (${notices(player)})`);
      check(player.bubbles.some((b) => b === "Server restarting in 1 minute 5 seconds"), `and a bubble with the time (${player.bubbles})`);
      check(admin.bubbles.some((b) => b.includes("65")) && !admin.bubbles.some((b) => b.includes("not supervised")), `confirmed, supervised (${admin.bubbles})`);
      await say(admin, ":restart cancel");
      check(notices(player).includes("server.alert:Server restart cancelled"), `cancel is announced (${notices(player)})`);
      for (const x of [admin, mod, player]) x.reset();
      await sleep(6000);
      check(notices(player).length === 0 && !player.closed, "a cancelled countdown sends nothing more");
      await say(admin, ":restart 4");
      await until(() => player.closed, 7000);
      check(notices(player).includes("server.alert:Server restarting in 3 seconds"), `the 3 second notice (${notices(player)})`);
      check(player.kickReason === 0 && player.closed && admin.closed, `everyone is disconnected (reason ${player.kickReason})`);
      await sleep(1500);
      const back = new Client(sup, "{rs-player}", "RsPlayer");
      back.username = player.username;
      await back.connect();
      check(back.myId > 0 && !back.closed, "the server is back after the restart");
      check(sup.sfsLog().includes("[supervisor] restarting"), "the supervisor restarted it");
      back.disconnect();
    } finally {
      await sup.stop();
    }
  }

  if (run("roles")) {
    await setRoleVia(bob, "moderator"); await setRoleVia(carol, "player");
    await root.connect(); await bob.connect(); await carol.connect();
    await SAY(root, `:promote ${carol.username} moderator`);
    check(root.bubbles.includes(`${carol.username} is now moderator`), `promote confirmed (${root.bubbles})`);
    await SAY(carol, ":online");
    check(carol.bubbles.some((b) => b.includes("online")), "the promoted player can use commands straight away");
    await SAY(root, `:demote ${carol.username.toUpperCase()}`);
    check(root.bubbles.includes(`${carol.username} is now player`), `demote confirmed, any case (${root.bubbles})`);
    await SAY(carol, ":online");
    check(bob.roomChats.includes(":online") && carol.bubbles.length === 0, "the demoted player's commands are chat again");
    await SAY(root, `:promote ${carol.username} owner`);
    check(root.errors.some((e) => e.startsWith("Usage:")), "unknown role is refused");
    await SAY(root, ":promote ghost admin");
    check(root.errors.includes("No account named ghost"), `unknown account (${root.errors})`);
    // Offline players can be promoted; the role applies at their next login.
    await SAY(root, `:promote ${dave.username} moderator`);
    check(root.errors.includes(`${dave.username} is an admin in STAFF_ADMINS`), `config admins can't be changed (${root.errors})`);
    const erin = new Client(servers, "{st-erin}", "Erin");
    await erin.account(); everyone.push(erin);
    await SAY(root, `:promote ${erin.username} moderator`);
    check(root.bubbles.includes(`${erin.username} is now moderator`), "promote an offline account");
    await erin.connect();
    await SAY(erin, ":online");
    check(erin.bubbles.some((b) => b.includes("online")), "the role applies when they log in");
    await SAY(root, `:demote ${root.username}`);
    check(root.errors.includes("You can't demote yourself"), `no demoting yourself (${root.errors})`);
    await SAY(bob, `:promote ${bob.username} admin`);
    check(bob.errors.includes("Unknown command"), "a moderator can't promote");
    await setRoleVia(carol, "player");
    await disconnectAll();
  }

  if (run("chat-signing")) {
    // Room chat must carry the web API's signature over the filtered text,
    // so a modified client can't skip the filter or speak as someone else.
    await bob.connect(); await carol.connect();
    for (const x of everyone) x.reset();
    bob.sendChatJson(JSON.stringify({ goodUntil: Date.now() + 60_000, signature: "", swid: bob.swid, data: { message: "unsigned words", emotion: 0 } }));
    await sleep(300);
    check(!carol.roomChats.includes("unsigned words"), "unsigned chat isn't relayed");
    await SAY(bob, "signed words");
    check(carol.roomChats.includes("signed words"), "chat signed by the web API is relayed");
    const vr = await fetch(`${servers.api.base}/chat/v1/message/verify`, {
      method: "POST", headers: { Authorization: "Basic " + btoa(`${bob.swid}:x`), "Content-Type": "application/json" },
      body: JSON.stringify({ senderSessionId: Number(bob.sid), message: "original", emotion: 0 }),
    });
    const signed = await vr.json() as any;
    for (const x of everyone) x.reset();
    bob.sendChatJson(JSON.stringify({ ...signed, data: { ...signed.data, message: "altered" } }));
    await sleep(300);
    check(!carol.roomChats.includes("altered"), "a signed message with altered text isn't relayed");
    carol.sendChatJson(JSON.stringify(signed));
    await sleep(300);
    check(!bob.roomChats.includes("original"), "another player's signed message can't be replayed as yours");
    // Chat signatures use their own key derived from the join key, so a
    // signature made directly with the join key (the login's) never counts.
    const gu = Date.now() + 60_000;
    const rawSig = (await import("node:crypto")).createHmac("sha256", servers.key)
      .update(`chat|${bob.swid}|${gu}|0|0|raw key words`).digest("base64url");
    for (const x of everyone) x.reset();
    bob.sendChatJson(JSON.stringify({ goodUntil: gu, swid: bob.swid, signature: rawSig, data: { senderSessionId: Number(bob.sid), message: "raw key words", emotion: 0, moderated: false } }));
    await sleep(300);
    check(!carol.roomChats.includes("raw key words"), "a chat signature made with the join key itself is refused");
    await SAY(bob, "x".repeat(201));
    check(bob.lastVerify === 400 && carol.roomChats.length === 0, `chat over 200 characters is refused (${bob.lastVerify})`);
    await disconnectAll();
  }

  if (run("dancebattle")) {
    await root.connect(); await bob.connect();
    const lobbyItems = (c: Client) => c.mmo.filter((m) => m.a === 30 && m.p.q);
    for (const c of [root, bob]) c.reset();
    await SAY(root, ":dancebattle");
    check(root.bubbles.some((b) => b.includes("Dance Battle lobby opened")), `:dancebattle opens a lobby (${root.bubbles}, ${root.errors})`);
    check(lobbyItems(bob).length === 1, "the whole room sees the lobby item");
    await SAY(root, ":dancebattle");
    check(root.errors.includes("A lobby or game is already running here") && lobbyItems(bob).length === 0, `a second one is refused, no new item (${root.errors})`);
    await SAY(bob, ":dancebattle");
    check(root.roomChats.includes(":dancebattle") && lobbyItems(root).length === 0 && bob.bubbles.length + bob.errors.length === 0, "a player's :dancebattle is plain chat and opens nothing");
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
      await admin.chat(":online");
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
