// Mix avatars: PUT /avatar stores the caller's avatar, and every user
// object the server sends (state, users/byUserId, chat members, search)
// carries it. Friends get a SetAvatar notification with the same AvatarId,
// which the SDK matches against its stored users (LocalUser.UpdateAvatar).
import { startWebApi, makeChecker } from "./lib/harness.ts";
import { MixClient, createPlayer } from "./lib/mix-client.ts";

const api = await startWebApi({ env: { ALLOW_SWID_AUTH: "1", MIX_AVATAR_SETS_PER_MIN: "4" } });
const { check, finish } = makeChecker();

async function befriend(x: MixClient, y: MixClient, yName: string) {
  const inv = await x.call("PUT", "/friendship/invitation", { InviteeDisplayName: yName, IsTrusted: true });
  x.apply(inv.body.Notification, "AddFriendshipInvitation");
  const incoming = (await y.drain()).find((g) => g.type === "AddFriendshipInvitation")!.n;
  const acc = await y.call("PUT", "/friendship", { InvitationId: incoming.Invitation.FriendshipInvitationId, IsTrusted: true });
  y.apply(acc.body.Notification, "AddFriendship");
  await x.drain();
}

const part = (key: string, tint: number, x = 0, y = 0) => ({ SelectionKey: key, TintIndex: tint, XOffset: x, YOffset: y });
const custom = {
  // The editor sends long.MinValue ("new avatar"), which JSON rounds.
  AvatarId: -9223372036854776000,
  SlotId: 0,
  Accessory: part("4", 2), Brow: part("10", 1, 0, 0.01), Costume: part("16", 3),
  Eyes: part("55", 4, 0.002, 0.02), Hair: part("70", 5), Hat: part("0", 0),
  Nose: part("107", 6), Mouth: part("195", 7, -0.002), Skin: part("124", 8),
};
const sameLook = (a: any, b: any) =>
  ["Accessory", "Brow", "Costume", "Eyes", "Hair", "Hat", "Nose", "Mouth", "Skin"].every(
    (k) => a?.[k]?.SelectionKey === b[k].SelectionKey && a[k].TintIndex === b[k].TintIndex && a[k].XOffset === b[k].XOffset && a[k].YOffset === b[k].YOffset,
  );

try {
  const users: MixClient[] = [];
  for (const [swid, name] of [["{AV-A}", "avataralice"], ["{AV-B}", "avatarbob"], ["{AV-C}", "avatarcarol"]] as const) {
    await createPlayer(api.base, api.dbPath, swid, name);
    const c = new MixClient(api.base);
    await c.login(name, `pw-${name}`);
    await c.startSession();
    await c.state();
    users.push(c);
  }
  const [A, B, C] = users as [MixClient, MixClient, MixClient];
  await befriend(A, B, "avatarbob");
  const ownBefore = (await A.state()).Users.find((u: any) => u.UserId === "{AV-A}").Avatar;

  const put = await A.call("PUT", "/avatar", { Avatar: custom });
  check(put.http === 200 && put.body?.Status === "OK", `PUT /avatar succeeds (${put.http} ${JSON.stringify(put.body)?.slice(0, 200)})`);
  const n = put.body?.Notification;
  check(A.apply(n, "SetAvatar"), `the response's SetAvatar notification is valid and next in sequence (${JSON.stringify(n)?.slice(0, 200)})`);
  check(n?.Avatar?.AvatarId === ownBefore.AvatarId, `it keeps the user's AvatarId (${n?.Avatar?.AvatarId} vs ${ownBefore.AvatarId})`);
  check(sameLook(n?.Avatar, custom), "it carries the new look");

  const own = (await A.state()).Users.find((u: any) => u.UserId === "{AV-A}").Avatar;
  check(sameLook(own, custom) && own.AvatarId === ownBefore.AvatarId, "the owner's /state has the new look");

  const got = await B.drain();
  const fn = got.find((g) => g.type === "SetAvatar")?.n;
  check(!!fn && fn.Avatar.AvatarId === ownBefore.AvatarId && sameLook(fn.Avatar, custom), `a friend gets SetAvatar with the same AvatarId (${JSON.stringify(got.map((g) => g.type))})`);
  const inState = (await B.state()).Users.find((u: any) => u.UserId === "{AV-A}")?.Avatar;
  check(sameLook(inState, custom), "a friend's /state shows the new look");
  const byId = await B.call("POST", "/users/byUserId", { UserIds: ["{AV-A}"] });
  check(sameLook(byId.body?.Users?.[0]?.Avatar, custom), "/users/byUserId shows the new look");

  const thread = await A.call("PUT", "/chatThread", { ChatThreadType: "ONE_ON_ONE", MemberUserIds: ["{AV-B}"] });
  const member = thread.body?.Notification?.ChatThread?.Members?.find((m: any) => m.UserId === "{AV-A}");
  check(sameLook(member?.Avatar, custom), "chat thread members carry the new look");
  A.apply(thread.body.Notification, "AddChatThread");
  await B.drain();

  const strangers = await C.drain();
  check(!strangers.some((g) => g.type === "SetAvatar"), "a stranger gets no SetAvatar notification");
  const search = await C.call("POST", "/search/displayname", { DisplayName: "avataralice" });
  check(sameLook(search.body?.Avatar, custom), "display-name search shows the new look");

  // A part left out is filled from the default, so the SDK's AvatarBuilder
  // never dereferences a null property.
  const { Hat, ...noHat } = custom;
  const partial = await A.call("PUT", "/avatar", { Avatar: noHat });
  check(partial.http === 200 && typeof partial.body?.Notification?.Avatar?.Hat?.TintIndex === "number", `a missing part is filled in (${partial.http})`);
  A.apply(partial.body.Notification, "SetAvatar");
  await B.drain();

  for (const [why, avatar] of [
    ["no avatar", undefined],
    ["a non-numeric tint", { ...custom, Eyes: { ...custom.Eyes, TintIndex: "x" } }],
    ["a huge selection key", { ...custom, Hair: { ...custom.Hair, SelectionKey: "9".repeat(500) } }],
    ["a non-finite offset", { ...custom, Nose: { ...custom.Nose, XOffset: 1e999 } }],
  ] as const) {
    const bad = await A.call("PUT", "/avatar", { Avatar: avatar });
    check(bad.http === 400 && bad.body?.Status === "INVALID_REQUEST", `${why} is refused (${bad.http} ${bad.body?.Status})`);
  }
  const still = (await B.state()).Users.find((u: any) => u.UserId === "{AV-A}")?.Avatar;
  check(still?.Eyes?.TintIndex === custom.Eyes.TintIndex, "refused requests change nothing");

  // Each set notifies every friend, so it is rate limited per user.
  const statuses: number[] = [];
  for (let i = 0; i < 4; i++) statuses.push((await A.call("PUT", "/avatar", { Avatar: custom })).http);
  check(statuses.includes(429), `avatar sets past the limit are throttled (${statuses})`);
} finally {
  api.stop();
}
finish(api.logs());
