// Mix chat threads (services/mixChat.ts): PUT /chatThread and the chat
// fields of /state. alice-bob are trusted friends, alice-carol untrusted
// friends, bob-carol not friends.
import { Database } from "bun:sqlite";
import { startWebApi, makeChecker } from "./lib/harness.ts";
import { MixClient, createPlayer } from "./lib/mix-client.ts";

const api = await startWebApi({
  env: { ALLOW_SWID_AUTH: "1" },
  // Filter rules for the moderation checks (creating the table skips the starter list).
  beforeStart: (dbPath) => {
    const d = new Database(dbPath);
    d.exec(`CREATE TABLE IF NOT EXISTS mix_moderation_rules (id INTEGER PRIMARY KEY AUTOINCREMENT, pattern TEXT NOT NULL,
      kind TEXT NOT NULL, action TEXT NOT NULL, created_at TEXT DEFAULT CURRENT_TIMESTAMP)`);
    d.run("INSERT INTO mix_moderation_rules (pattern, kind, action) VALUES ('darn', 'word', 'mask'), ('heck', 'word', 'block')");
    d.close();
  },
});
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
  check(notFriends.http === 400 && notFriends.body?.Status === "FORBIDDEN_NOT_FRIENDS", `bob's group with carol (not a friend) -> ${notFriends.http} ${notFriends.body?.Status}`);
  const tooBig = await A!.call("PUT", "/chatThread", { ChatThreadType: "GROUP", MemberUserIds: Array.from({ length: 20 }, (_, i) => `{FAKE-${i}}`) });
  check(tooBig.http === 400 && tooBig.body?.Status === "MAX_MEMBER_COUNT_EXCEEDED", `a 21-person group -> ${tooBig.http} ${tooBig.body?.Status}`);
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

  // ---- Messages (Task 12) ----
  let cid = 1000;
  const send = (c: MixClient, kind: "text" | "sticker" | "gag", threadId: number, fields: object, clientId = ++cid) =>
    c.call("PUT", `/chatThread/${kind}Message`, { ChatThreadId: threadId, ClientChatMessageId: clientId, ...fields });

  // Text in the 1:1.
  const hi = await send(A!, "text", t1.ChatThreadId, { Text: "hi 👋" }, 1);
  const hm = hi.body?.Notification?.Message;
  check(hi.http === 200 && hm?.Text === "hi 👋" && hm?.SequenceNumber === 1 && hm?.MessageType === "TEXT" && hm?.IsModerated === false && hm?.SenderUserId === "{CHAT-A}" && hm?.ClientChatMessageId === 1,
    `alice sends "hi 👋" -> ${hi.http} ${JSON.stringify(hi.body)?.slice(0, 220)}`);
  check(!!hi.body?.Notification && A!.apply(hi.body.Notification, "AddChatThreadTextMessage"), "alice's copy is her next notification and passes the validator");
  const bText = (await B!.drain()).filter((g) => g.type === "AddChatThreadTextMessage");
  check(bText.length === 1 && bText[0]!.n.Message.Text === "hi 👋" && bText[0]!.n.Message.SequenceNumber === 1 && bText[0]!.n.Message.ChatMessageId === hm?.ChatMessageId, `bob drains the text message (${bText.length})`);

  // Retry with the same ClientChatMessageId.
  const retry = await send(A!, "text", t1.ChatThreadId, { Text: "hi 👋" }, 1);
  check(retry.http === 200 && JSON.stringify(retry.body?.Notification) === JSON.stringify(hi.body?.Notification), "a retried send returns the identical notification");
  check((await B!.drain()).length === 0, "bob gets nothing for the retry");

  // Moderation and length.
  const darn = await send(A!, "text", t1.ChatThreadId, { Text: "darn it" });
  check(darn.http === 200 && darn.body?.Notification?.Message?.Text === "**** it" && darn.body?.Notification?.Message?.IsModerated === true && A!.apply(darn.body.Notification, "AddChatThreadTextMessage"),
    `"darn it" is stored masked (${JSON.stringify(darn.body?.Notification?.Message?.Text)})`);
  const heck = await send(A!, "text", t1.ChatThreadId, { Text: "what the heck" });
  check(heck.http === 400 && heck.body?.Status === "MODERATION_BLOCKED", `blocked text -> ${heck.http} ${heck.body?.Status}`);
  const long = await send(A!, "text", t1.ChatThreadId, { Text: "a".repeat(1001) });
  check(long.http === 400 && long.body?.Status === "INVALID_REQUEST", `1001 characters -> ${long.http} ${long.body?.Status}`);
  const empty = await send(A!, "text", t1.ChatThreadId, { Text: "" });
  check(empty.http === 400 && empty.body?.Status === "INVALID_REQUEST", `empty text -> ${empty.http} ${empty.body?.Status}`);
  const noCid = await A!.call("PUT", "/chatThread/textMessage", { ChatThreadId: t1.ChatThreadId, Text: "x" });
  check(noCid.http === 400 && noCid.body?.Status === "INVALID_REQUEST", `missing ClientChatMessageId -> ${noCid.http} ${noCid.body?.Status}`);
  const carolIn = await send(C!, "text", t1.ChatThreadId, { Text: "let me in" });
  check(carolIn.http === 400 && carolIn.body?.Status === "NOT_FOUND", `carol (not a member) -> ${carolIn.http} ${carolIn.body?.Status}`);
  const noThread = await send(A!, "text", 999999, { Text: "x" });
  check(noThread.http === 400 && noThread.body?.Status === "NOT_FOUND", `unknown thread -> ${noThread.http} ${noThread.body?.Status}`);
  await B!.drain();

  // Sticker and gag in the group.
  const stk = await send(A!, "sticker", t2.ChatThreadId, { ContentId: "sticker_happy_01" });
  const sm = stk.body?.Notification?.Message;
  check(stk.http === 200 && sm?.MessageType === "STICKER" && sm?.ContentId === "sticker_happy_01" && sm?.SequenceNumber === 1 && A!.apply(stk.body.Notification, "AddChatThreadStickerMessage"), `sticker -> ${stk.http} ${JSON.stringify(sm)}`);
  const gag = await send(A!, "gag", t2.ChatThreadId, { ContentId: "gag_pie", TargetUserId: "{CHAT-B}" });
  const gm = gag.body?.Notification?.Message;
  check(gag.http === 200 && gm?.MessageType === "GAG" && gm?.TargetUserId === "{CHAT-B}" && gm?.SequenceNumber === 2 && A!.apply(gag.body.Notification, "AddChatThreadGagMessage"), `gag -> ${gag.http} ${JSON.stringify(gm)}`);
  const badGag = await send(A!, "gag", t2.ChatThreadId, { ContentId: "gag_pie", TargetUserId: "{NOT-A-MEMBER}" });
  check(badGag.http === 400 && badGag.body?.Status === "INVALID_REQUEST", `gag at a non-member -> ${badGag.http} ${badGag.body?.Status}`);
  const noContent = await send(A!, "sticker", t2.ChatThreadId, { ContentId: "" });
  check(noContent.http === 400 && noContent.body?.Status === "INVALID_REQUEST", `sticker without ContentId -> ${noContent.http} ${noContent.body?.Status}`);
  for (const [name, c] of [["bob", B!], ["carol", C!]] as const) {
    const got = await c.drain();
    check(got.some((g) => g.type === "AddChatThreadStickerMessage") && got.some((g) => g.type === "AddChatThreadGagMessage"), `${name} drains the sticker and the gag`);
  }

  // Burst: alice and bob send 10 each at once; everyone stays gap-free.
  const burst = [];
  for (let i = 0; i < 10; i++) {
    burst.push(send(A!, "text", t2.ChatThreadId, { Text: `a${i}` }));
    burst.push(send(B!, "text", t2.ChatThreadId, { Text: `b${i}` }));
  }
  const results = await Promise.all(burst);
  check(results.every((r) => r.http === 200), `20 concurrent sends all OK (${results.map((r) => r.http).filter((h) => h !== 200).join() || "200s"})`);
  for (const [name, c] of [["alice", A!], ["bob", B!], ["carol", C!]] as const) {
    let ok = true;
    try { await c.drain(); } catch (e) { ok = false; console.log((e as Error).message); }
    check(ok, `${name}'s drain after the burst is gap-free`);
  }
  const d = new Database(api.dbPath, { readonly: true });
  const seqs = (d.query("SELECT seq FROM mix_chat_messages WHERE thread_id = ? ORDER BY seq").all(t2.ChatThreadId) as any[]).map((r) => r.seq);
  d.close();
  check(seqs.length === 22 && seqs.every((v, i) => v === i + 1), `group seqs are exactly 1..22 (${seqs.length}: ${seqs.slice(0, 5)}...${seqs.slice(-2)})`);
  const st2 = await A!.state();
  const latest2 = pairs(st2.ChatThreadLatestMessageSequenceNumbers);
  check(latest2.get(t1.ChatThreadId) === 2 && latest2.get(t2.ChatThreadId) === 22, `/state latest seqs follow the messages (${JSON.stringify(st2.ChatThreadLatestMessageSequenceNumbers)})`);

  // ---- Members (Task 13) ----
  const mk = await A!.call("PUT", "/chatThread", { ChatThreadType: "GROUP", MemberUserIds: ["{CHAT-B}"] });
  const g3 = mk.body.Notification.ChatThread;
  check(g3.IsTrusted === true && A!.apply(mk.body.Notification, "AddChatThread"), "alice+bob group is trusted");
  await B!.drain();

  const addC = await A!.call("PUT", "/chatThreadMembership", { ChatThreadId: g3.ChatThreadId, AddedUserIds: ["{CHAT-C}"] });
  const mn = addC.body?.MembershipNotification, cmn = addC.body?.ChatMessageNotification;
  check(addC.http === 200 && addC.body?.Status === "OK" && mn?.ChatThreadId === g3.ChatThreadId && mn?.Members?.length === 1 && mn.Members[0].UserId === "{CHAT-C}" && mn.WelcomingUserId === "{CHAT-A}",
    `alice adds carol -> ${addC.http} ${JSON.stringify(mn)?.slice(0, 160)}`);
  const lm = cmn?.Message;
  check(lm?.MessageType === "MEMBER_LIST_CHANGED" && lm?.IsAdded === true && JSON.stringify(lm?.MemberUserIds) === JSON.stringify(["{CHAT-C}"]) && lm?.SenderUserId === "{CHAT-A}" && lm?.SequenceNumber === 1,
    `system message ${JSON.stringify(lm)}`);
  check(!!mn && !!cmn && A!.apply(mn, "AddChatThreadMembership") && A!.apply(cmn, "AddChatThreadMemberListChangedMessage"), "alice's two copies are her next two notifications");
  const cGot = (await C!.drain()).map((g) => g.type);
  check(JSON.stringify(cGot) === JSON.stringify(["AddChatThread", "AddChatThreadMembership", "AddChatThreadMemberListChangedMessage"]), `carol drains thread, membership, message (${cGot})`);
  const bGot2 = (await B!.drain()).map((g) => g.type);
  check(JSON.stringify(bGot2) === JSON.stringify(["AddChatThreadMembership", "AddChatThreadMemberListChangedMessage", "UpdateChatThreadTrustStatus"]), `bob drains membership, message, trust drop (${bGot2})`);
  const aTrust = (await A!.drain()).find((g) => g.type === "UpdateChatThreadTrustStatus")?.n;
  check(aTrust?.ChatThreadId === g3.ChatThreadId && aTrust?.IsTrusted === false, "adding an untrusted friend makes the group untrusted for alice too");
  const cState = await C!.state();
  const cThread = cState.ChatThreads.find((t: any) => t.ChatThreadId === g3.ChatThreadId);
  check(cThread?.IsTrusted === false && cThread?.Members?.length === 3, "carol's /state shows the 3-person untrusted group");

  const again2 = await A!.call("PUT", "/chatThreadMembership", { ChatThreadId: g3.ChatThreadId, AddedUserIds: ["{CHAT-C}"] });
  check(again2.http === 400 && again2.body?.Status === "USER_ALREADY_THREAD_MEMBER", `adding carol again -> ${again2.http} ${again2.body?.Status}`);
  const bobAdds = await B!.call("PUT", "/chatThreadMembership", { ChatThreadId: t2.ChatThreadId, AddedUserIds: ["{CHAT-X}"] });
  check(bobAdds.http === 400 && bobAdds.body?.Status === "FORBIDDEN_NOT_FRIENDS", `adding a non-friend -> ${bobAdds.http} ${bobAdds.body?.Status}`);
  const to1on1 = await A!.call("PUT", "/chatThreadMembership", { ChatThreadId: t1.ChatThreadId, AddedUserIds: ["{CHAT-C}"] });
  check(to1on1.http === 400 && to1on1.body?.Status === "INVALID_REQUEST", `adding to the 1:1 -> ${to1on1.http} ${to1on1.body?.Status}`);
  const bobKicks = await B!.call("POST", "/chatThreadMembership/delete", { ChatThreadId: g3.ChatThreadId, RemovedUserId: "{CHAT-C}" });
  check(bobKicks.http === 400 && bobKicks.body?.Status === "USER_NOT_THREAD_MEMBER", `bob (not the creator) removing carol -> ${bobKicks.http} ${bobKicks.body?.Status}`);

  // Carol leaves.
  const leave = await C!.call("POST", "/chatThreadMembership/delete", { ChatThreadId: g3.ChatThreadId, RemovedUserId: "{CHAT-C}" });
  const rn = leave.body?.MembershipNotification, rcm = leave.body?.ChatMessageNotification;
  check(leave.http === 200 && rn?.MemberUserId === "{CHAT-C}" && rcm?.Message?.IsAdded === false && C!.apply(rn, "RemoveChatThreadMembership") && C!.apply(rcm, "AddChatThreadMemberListChangedMessage"),
    `carol leaves -> ${leave.http} ${JSON.stringify(rn)}`);
  for (const [name, c] of [["alice", A!], ["bob", B!]] as const) {
    const got = (await c.drain()).map((g) => g.type);
    check(JSON.stringify(got) === JSON.stringify(["RemoveChatThreadMembership", "AddChatThreadMemberListChangedMessage"]), `${name} drains the removal and the system message (${got})`);
  }
  const carolSends = await send(C!, "text", g3.ChatThreadId, { Text: "still here?" });
  check(carolSends.http === 400 && carolSends.body?.Status === "NOT_FOUND", `carol sending after leaving -> ${carolSends.http} ${carolSends.body?.Status}`);
  check(!(await C!.state()).ChatThreads.some((t: any) => t.ChatThreadId === g3.ChatThreadId), "carol's /state no longer lists the group");
  const leave1on1 = await A!.call("POST", "/chatThreadMembership/delete", { ChatThreadId: t1.ChatThreadId, RemovedUserId: "{CHAT-A}" });
  check(leave1on1.http === 400 && leave1on1.body?.Status === "INVALID_REQUEST", `leaving a 1:1 -> ${leave1on1.http} ${leave1on1.body?.Status}`);

  // The creator can remove someone else.
  const kick = await A!.call("POST", "/chatThreadMembership/delete", { ChatThreadId: g3.ChatThreadId, RemovedUserId: "{CHAT-B}" });
  check(kick.http === 200 && A!.apply(kick.body.MembershipNotification, "RemoveChatThreadMembership") && A!.apply(kick.body.ChatMessageNotification, "AddChatThreadMemberListChangedMessage"), `alice (creator) removes bob -> ${kick.http}`);
  check((await B!.drain()).map((g) => g.type).join() === "RemoveChatThreadMembership,AddChatThreadMemberListChangedMessage", "bob is told he was removed");

  // ---- History (Task 14) ----
  const LISTS = ["Text", "Sticker", "Gag", "Video", "Photo", "GameState", "GameEvent", "MemberListChanged"];
  const allLists = (b: any) => LISTS.every((k) => Array.isArray(b?.[k]));
  const seqsOf = (b: any) => LISTS.flatMap((k) => (b?.[k] ?? []).map((m: any) => m.SequenceNumber)).sort((x: number, y: number) => x - y);
  const g4n = await A!.call("PUT", "/chatThread", { ChatThreadType: "GROUP", MemberUserIds: ["{CHAT-B}"] });
  const g4 = g4n.body.Notification.ChatThread.ChatThreadId;
  A!.apply(g4n.body.Notification, "AddChatThread");
  for (let i = 1; i <= 60; i++) await send(B!, "text", g4, { Text: `m${i}` });
  await A!.drain(); await B!.drain();

  const p1 = await A!.call("POST", "/chatThread", { ChatThreadId: g4 });
  check(p1.http === 200 && allLists(p1.body) && p1.body.Text.length === 50 && typeof p1.body.Cursor === "string", `page 1: ${p1.body?.Text?.length} messages, cursor ${p1.body?.Cursor}`);
  check(JSON.stringify(seqsOf(p1.body)) === JSON.stringify(Array.from({ length: 50 }, (_, i) => i + 11)), "page 1 is the newest 50 (11..60)");
  const p2 = await A!.call("POST", "/chatThread", { ChatThreadId: g4, Cursor: p1.body.Cursor });
  check(p2.http === 200 && p2.body.Text.length === 10 && p2.body.Cursor === null && JSON.stringify(seqsOf(p2.body)) === JSON.stringify([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]), `page 2: ${p2.body?.Text?.length}, cursor ${p2.body?.Cursor}`);
  check(p1.body.Text.every((m: any) => m.MessageType === "TEXT" && typeof m.Created === "number" && m.SenderUserId === "{CHAT-B}" && m.IsModerated === false), "history messages are complete text messages");

  const rng = await A!.call("POST", "/chatThread/messages/bySequenceRange", { ChatThreadId: g4, Ranges: [1, 3, 5, 5] });
  check(rng.http === 200 && allLists(rng.body) && JSON.stringify(seqsOf(rng.body)) === "[1,2,3,5]", `ranges [1,3,5,5] -> ${JSON.stringify(seqsOf(rng.body))}`);
  const odd = await A!.call("POST", "/chatThread/messages/bySequenceRange", { ChatThreadId: g4, Ranges: [1, 3, 5] });
  check(odd.http === 400 && odd.body?.Status === "INVALID_REQUEST", `odd-length ranges -> ${odd.http} ${odd.body?.Status}`);

  const rec = await A!.call("POST", "/chatThread/messages/recent", { LowerBoundSequenceNumbers: [g4, 55], MaxMessagesPerChatThread: 20 });
  check(rec.http === 200 && allLists(rec.body) && JSON.stringify(seqsOf(rec.body)) === "[55,56,57,58,59,60]", `recent from seq 55 -> ${JSON.stringify(seqsOf(rec.body))}`);
  const recDefault = await A!.call("POST", "/chatThread/messages/recent", { LowerBoundSequenceNumbers: [g4, 1] });
  check(seqsOf(recDefault.body).length === 20 && seqsOf(recDefault.body)[0] === 41, "recent defaults to the newest 20");

  const sn = await A!.call("POST", "/chatThread/messages/sequenceNumber", { ChatThreadId: g4, StartMessageTimestamp: Date.now() + 1000 });
  const snl = sn.body?.SequenceNumbers ?? [];
  check(sn.http === 200 && snl.length === 120 && snl.length % 2 === 0 && snl[snl.length - 1] === 60 && snl.every((v: number) => v > 0), `sequenceNumber gives [messageId, seq] pairs up to 60 (${snl.length})`);

  const firstId = p2.body.Text.find((m: any) => m.SequenceNumber === 1).ChatMessageId;
  const spec = await A!.call("POST", "/chatThread/specificMessages", { ChatThreadId: g4, MessageIds: [firstId, 999999] });
  check(spec.http === 200 && allLists(spec.body) && spec.body.Text.length === 1 && spec.body.Text[0].ChatMessageId === firstId, "specificMessages returns the visible id and skips the unknown one");
  const since = await A!.call("POST", "/chatThread/recentMessages", { MessagesSince: 0 });
  check(since.http === 200 && allLists(since.body) && since.body.Text.filter((m: any) => m.ChatThreadId === g4).length === 60, "recentMessages since 0 covers the group's 60 texts");

  // Late joiner: carol, added at seq 60, sees only from 61 on.
  const addC4 = await A!.call("PUT", "/chatThreadMembership", { ChatThreadId: g4, AddedUserIds: ["{CHAT-C}"] });
  A!.apply(addC4.body.MembershipNotification, "AddChatThreadMembership"); A!.apply(addC4.body.ChatMessageNotification, "AddChatThreadMemberListChangedMessage");
  await A!.drain(); await B!.drain(); await C!.drain();
  const cPage = await C!.call("POST", "/chatThread", { ChatThreadId: g4 });
  check(cPage.http === 200 && JSON.stringify(seqsOf(cPage.body)) === "[61]" && cPage.body.MemberListChanged.length === 1, `carol's history is just her join message (${JSON.stringify(seqsOf(cPage.body))})`);
  const cRng = await C!.call("POST", "/chatThread/messages/bySequenceRange", { ChatThreadId: g4, Ranges: [1, 61] });
  check(JSON.stringify(seqsOf(cRng.body)) === "[61]", "carol's range read hides seqs 1..60");
  const cRec = await C!.call("POST", "/chatThread/messages/recent", { LowerBoundSequenceNumbers: [g4, 1] });
  check(JSON.stringify(seqsOf(cRec.body)) === "[61]", "carol's recent read hides seqs 1..60");
  const cSpec = await C!.call("POST", "/chatThread/specificMessages", { ChatThreadId: g4, MessageIds: [firstId] });
  check(cSpec.http === 200 && cSpec.body.Text.length === 0, "carol can't fetch an old message by id");

  // Outsider and former member.
  const out1 = await C!.call("POST", "/chatThread/messages/bySequenceRange", { ChatThreadId: t1.ChatThreadId, Ranges: [1, 10] });
  check(out1.http === 400 && out1.body?.Status === "NOT_FOUND", `carol reading the alice-bob 1:1 -> ${out1.http} ${out1.body?.Status}`);
  const out2 = await C!.call("POST", "/chatThread", { ChatThreadId: t1.ChatThreadId });
  check(out2.http === 400 && out2.body?.Status === "NOT_FOUND", `carol paging the 1:1 -> ${out2.http} ${out2.body?.Status}`);
  const formerly = await C!.call("POST", "/chatThread/messages/bySequenceRange", { ChatThreadId: g3.ChatThreadId, Ranges: [1, 10] });
  check(formerly.http === 200 && JSON.stringify(seqsOf(formerly.body)) === "[1,2]", `carol, who left g3 at seq 2, sees 1..2 but not bob's removal at 3 (${JSON.stringify(seqsOf(formerly.body))})`);
} finally {
  api.stop();
}
finish(api.logs());
