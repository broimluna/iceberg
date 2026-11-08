// Mix chat messages are stored for good and copied to every member's
// notifications, so their size and rate are bounded: a game state is at
// most 64 KB, and each user may send MIX_CHAT_MESSAGES_PER_MIN messages a
// minute (HTTP 429, which the SDK reports as THROTTLED).
import { startWebApi, makeChecker } from "./lib/harness.ts";
import { MixClient, createPlayer } from "./lib/mix-client.ts";

const api = await startWebApi({ env: { ALLOW_SWID_AUTH: "1", MIX_CHAT_MESSAGES_PER_MIN: "5" } });
const { check, finish } = makeChecker();

async function befriend(x: MixClient, y: MixClient, yName: string) {
  const inv = await x.call("PUT", "/friendship/invitation", { InviteeDisplayName: yName, IsTrusted: true });
  x.apply(inv.body.Notification, "AddFriendshipInvitation");
  const incoming = (await y.drain()).find((g) => g.type === "AddFriendshipInvitation")!.n;
  const acc = await y.call("PUT", "/friendship", { InvitationId: incoming.Invitation.FriendshipInvitationId, IsTrusted: true });
  y.apply(acc.body.Notification, "AddFriendship");
  await x.drain();
}

try {
  const users: MixClient[] = [];
  for (const [swid, name] of [["{LIM-A}", "limitalice"], ["{LIM-B}", "limitbob"]] as const) {
    await createPlayer(api.base, api.dbPath, swid, name);
    const c = new MixClient(api.base);
    await c.login(name, `pw-${name}`);
    await c.startSession();
    await c.state();
    users.push(c);
  }
  const [A, B] = users as [MixClient, MixClient];
  await befriend(A, B, "limitbob");
  const thread = (await A.call("PUT", "/chatThread", { ChatThreadType: "ONE_ON_ONE", MemberUserIds: ["{LIM-B}"] })).body.Notification.ChatThread.ChatThreadId;
  let cid = 1;
  const game = (payload: string) => A.call("PUT", "/chatThread/gameStateMessage", { ChatThreadId: thread, ClientChatMessageId: cid++, GameName: "Runner", Payload: payload });

  const ok = await game(JSON.stringify({ ghost: "x".repeat(1000) }));
  check(ok.http === 200, `a game state is sent (${ok.http} ${ok.body?.Status})`);
  const big = await game("x".repeat(65 * 1024));
  check(big.http === 400 && big.body?.Status === "INVALID_REQUEST", `a game state over 64 KB is refused (${big.http} ${big.body?.Status})`);

  const statuses: number[] = [];
  for (let i = 0; i < 6; i++) statuses.push((await A.call("PUT", "/chatThread/textMessage", { ChatThreadId: thread, ClientChatMessageId: cid++, Text: `hi ${i}` })).http);
  // One game state and one refused one already counted; 5 per minute in all.
  check(statuses.filter((s) => s === 429).length >= 2 && statuses[0] === 200, `messages past 5 a minute are throttled (${statuses})`);
  const other = await B.call("PUT", "/chatThread/textMessage", { ChatThreadId: thread, ClientChatMessageId: 1, Text: "still me" });
  check(other.http === 200, `the limit is per user: bob can still talk (${other.http})`);
} finally {
  api.stop();
}
finish(api.logs());
