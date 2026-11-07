// Mix chat threads (services/mixChat.ts): PUT /chatThread and the chat
// fields of /state. alice-bob are trusted friends, alice-carol untrusted
// friends, bob-carol not friends.
import { startWebApi, makeChecker } from "./lib/harness.ts";
import { MixClient, createPlayer } from "./lib/mix-client.ts";

const api = await startWebApi({ env: { ALLOW_SWID_AUTH: "1" } });
const { check, finish } = makeChecker();

// Flat [threadId, seq, threadId, seq, ...] list -> Map (SequenceNumberUtils).
const pairs = (l: any[]) => { const m = new Map<number, number>(); for (let i = 0; i + 1 < (l ?? []).length; i += 2) m.set(l[i], l[i + 1]); return m; };

async function befriend(x: MixClient, y: MixClient, yName: string, trusted: boolean) {
  const inv = await x.call("PUT", "/friendship/invitation", { InviteeDisplayName: yName, IsTrusted: trusted });
  x.apply(inv.body.Notification, "AddFriendshipInvitation");
  const incoming = (await y.drain()).find((g) => g.type === "AddFriendshipInvitation")!.n;
  const acc = await y.call("PUT", "/friendship", { InvitationId: incoming.Invitation.FriendshipInvitationId, IsTrusted: trusted });
  y.apply(acc.body.Notification, "AddFriendship");
  await x.drain();
}

try {
  const users: Record<string, MixClient> = {};
  for (const [swid, name] of [["{CHAT-A}", "alice"], ["{CHAT-B}", "bob"], ["{CHAT-C}", "carol"]] as const) {
    await createPlayer(api.base, api.dbPath, swid, name);
    const c = new MixClient(api.base);
    await c.login(name, `pw-${name}`);
    await c.startSession();
    await c.state();
    users[name] = c;
  }
  const { alice: A, bob: B, carol: C } = users as Record<string, MixClient>;
  await befriend(A!, B!, "bob", true);
  await befriend(A!, C!, "carol", false);

  // 1:1 alice-bob.
  const one = await A!.call("PUT", "/chatThread", { ChatThreadType: "ONE_ON_ONE", MemberUserIds: ["{CHAT-B}"] });
  const t1 = one.body?.Notification?.ChatThread;
  check(one.http === 200 && one.body?.Status === "OK" && t1?.ChatThreadType === "ONE_ON_ONE" && typeof t1?.ChatThreadId === "number", `alice creates 1:1 with bob -> ${one.http} ${JSON.stringify(one.body)?.slice(0, 200)}`);
  check(!!one.body?.Notification && A!.apply(one.body.Notification, "AddChatThread"), "alice's response notification is her next sequence (validator + queue)");
  check(t1?.IsTrusted === true && one.body?.Notification?.WelcomingUserId === "{CHAT-A}", `trusted friends make a trusted thread, welcomed by alice (${t1?.IsTrusted})`);
  check((t1?.Members ?? []).map((m: any) => m.UserId).sort().join() === "{CHAT-A},{CHAT-B}" && t1.Members.every((m: any) => m.Avatar && m.DisplayName), "members are alice and bob, with names and avatars");
  const bGot = await B!.drain();
  const bThreads = bGot.filter((g) => g.type === "AddChatThread");
  check(bThreads.length === 1 && bThreads[0]!.n.ChatThread.ChatThreadId === t1?.ChatThreadId && bThreads[0]!.n.ChatThread.ChatThreadType === "ONE_ON_ONE", `bob drains one AddChatThread (${bThreads.length})`);

  // Again: same thread, only alice hears about it.
  const again = await A!.call("PUT", "/chatThread", { ChatThreadType: "ONE_ON_ONE", MemberUserIds: ["{CHAT-B}"] });
  check(again.body?.Notification?.ChatThread?.ChatThreadId === t1?.ChatThreadId && A!.apply(again.body.Notification, "AddChatThread"), "creating the 1:1 again returns the same thread as alice's next notification");
  check((await B!.drain()).length === 0, "bob gets nothing for the repeat");

  // Bad requests.
  const notFriends = await B!.call("PUT", "/chatThread", { ChatThreadType: "GROUP", MemberUserIds: ["{CHAT-A}", "{CHAT-C}"] });
  check(notFriends.http === 400 && notFriends.body?.Status === "USER_NOT_FRIEND", `bob's group with carol (not a friend) -> ${notFriends.http} ${notFriends.body?.Status}`);
  const twoInOne = await A!.call("PUT", "/chatThread", { ChatThreadType: "ONE_ON_ONE", MemberUserIds: ["{CHAT-B}", "{CHAT-C}"] });
  check(twoInOne.http === 400 && twoInOne.body?.Status === "INVALID_REQUEST", `1:1 with two others -> ${twoInOne.http} ${twoInOne.body?.Status}`);
  const badType = await A!.call("PUT", "/chatThread", { ChatThreadType: "OFFICIAL_ACCOUNT", MemberUserIds: ["{CHAT-B}"] });
  check(badType.http === 400 && badType.body?.Status === "INVALID_REQUEST", `type OFFICIAL_ACCOUNT can't be created -> ${badType.http} ${badType.body?.Status}`);
  const self = await A!.call("PUT", "/chatThread", { ChatThreadType: "ONE_ON_ONE", MemberUserIds: ["{CHAT-A}"] });
  check(self.http === 400 && self.body?.Status === "INVALID_REQUEST", `1:1 with yourself -> ${self.http} ${self.body?.Status}`);

  // Group alice + bob + carol (alice listed twice: deduplicated).
  const grp = await A!.call("PUT", "/chatThread", { ChatThreadType: "GROUP", MemberUserIds: ["{CHAT-B}", "{CHAT-C}", "{CHAT-C}", "{CHAT-A}"] });
  const t2 = grp.body?.Notification?.ChatThread;
  check(grp.http === 200 && t2?.ChatThreadType === "GROUP" && t2.Members.length === 3 && A!.apply(grp.body.Notification, "AddChatThread"), `alice creates a group -> ${grp.http} (${t2?.Members?.length} members)`);
  check(t2?.IsTrusted === false, "a group is untrusted unless every pair is trusted");
  for (const [name, c] of [["bob", B!], ["carol", C!]] as const) {
    const got = (await c.drain()).filter((g) => g.type === "AddChatThread");
    check(got.length === 1 && got[0]!.n.ChatThread.ChatThreadType === "GROUP" && got[0]!.n.ChatThread.ChatThreadId === t2?.ChatThreadId, `${name} gets the group's AddChatThread`);
  }

  // /state chat fields.
  const st = await A!.state();
  const ids = (st.ChatThreads ?? []).map((t: any) => t.ChatThreadId).sort();
  check(ids.length === 2 && ids.join() === [t1?.ChatThreadId, t2?.ChatThreadId].sort().join(), `alice's /state lists 2 threads (${ids})`);
  check(st.ChatThreads.every((t: any) => typeof t.IsTrusted === "boolean" && Array.isArray(t.Members) && t.OfficialAccountId === null), "state threads are complete");
  const latest = pairs(st.ChatThreadLatestMessageSequenceNumbers), seen = pairs(st.ChatThreadLastSeenMessageSequenceNumbers);
  check(st.ChatThreadLatestMessageSequenceNumbers.length === 4 && latest.get(t1?.ChatThreadId) === 0 && latest.get(t2?.ChatThreadId) === 0, `latest seqs are [id,0,id,0] (${JSON.stringify(st.ChatThreadLatestMessageSequenceNumbers)})`);
  check(seen.get(t1?.ChatThreadId) === 0 && seen.get(t2?.ChatThreadId) === 0, "last-seen seqs are 0");
  check(Array.isArray(st.ChatThreadUnreadMessageCount) && st.ChatThreadUnreadMessageCount.length === 0, "no unread counts yet");
  check(Array.isArray(st.ChatThreadNicknames) && Array.isArray(st.GameStateChatMessages) && st.GameStateChatMessages.length === 0, "nicknames and game-state lists present");
  const cst = await C!.state();
  check((cst.ChatThreads ?? []).length === 1 && cst.ChatThreads[0].ChatThreadType === "GROUP", "carol's /state lists only the group");
} finally {
  api.stop();
}
finish(api.logs());
