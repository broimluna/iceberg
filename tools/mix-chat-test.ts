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
} finally {
  api.stop();
}
finish(api.logs());
