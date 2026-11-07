// A Mix client that behaves like the real SDK (Disney.Mix.SDK.Internal),
// so tests see what the app sees:
// - Guest Controller login (api-key, then guest/login)
// - the RSA -> AES session key exchange (MixSessionStarter)
// - application/mix bodies, AES-256-CBC with an IV prefix (MixEncryptor)
// - the X-Mix-* headers (MixWebCallFactory)
// - notifications applied strictly at latest + 1, each checked against
//   the client's NotificationValidator rules
import crypto from "node:crypto";
import { Database } from "bun:sqlite";
import { decryptAesCbc, encryptAesCbc } from "../../web-api/src/lib/crypto.ts";
import { parseJson, stringifyJson } from "../../web-api/src/lib/bigJson.ts";

export const MIX_CLIENT_TOKEN = "F7EA7678-FE45-4A00-89EB-496EFDA74761";

/** Creates a player (server needs ALLOW_SWID_AUTH=1) and sets its display name. */
export async function createPlayer(base: string, dbPath: string, swid: string, displayName: string): Promise<void> {
  await fetch(`${base}/player/v1`, { headers: { Authorization: "Basic " + btoa(`${swid}:x`) } });
  const db = new Database(dbPath);
  const cols = db.query("SELECT name FROM pragma_table_info('player_identity')").all().map((x: any) => x.name);
  const nameCol = cols.includes("display_name") ? "display_name" : "displayName";
  db.run(`UPDATE player_identity SET ${nameCol} = ? WHERE swid = ?`, [displayName, swid]);
  db.close();
}

// Required fields per notification list, transcribed from
// NotificationValidator.cs. Every notification also needs a non-zero
// SequenceNumber (Validate(BaseNotification)).
const has = (v: unknown) => v !== null && v !== undefined;
const msgOk = (m: any) => !!m && [m.Created, m.ChatThreadId, m.ChatMessageId, m.MessageType, m.SenderUserId, m.ClientChatMessageId, m.SequenceNumber].every(has);
const idsOk = (a: any) => Array.isArray(a) && a.every(has);
export const REQUIRED: Record<string, (n: any) => boolean> = {
  AddNickname: (n) => has(n.Nickname?.Nickname) && has(n.Nickname?.NicknamedUserId),
  RemoveNickname: (n) => has(n.NicknamedUserId),
  AddChatThread: (n) => has(n.WelcomingUserId) && has(n.ChatThread?.ChatThreadId)
    && ["ONE_ON_ONE", "GROUP", "OFFICIAL_ACCOUNT"].includes(n.ChatThread?.ChatThreadType)
    && has(n.ChatThread?.IsTrusted) && Array.isArray(n.ChatThread?.Members),
  AddChatThreadMembership: (n) => has(n.WelcomingUserId) && has(n.ChatThreadId) && Array.isArray(n.Members)
    && n.Members.every((m: any) => has(m.DisplayName) && has(m.UserId)),
  RemoveChatThreadMembership: (n) => has(n.ChatThreadId) && has(n.MemberUserId),
  AddChatThreadTextMessage: (n) => msgOk(n.Message) && has(n.Message.IsModerated) && has(n.Message.Text),
  AddChatThreadStickerMessage: (n) => msgOk(n.Message) && has(n.Message.ContentId),
  AddChatThreadGagMessage: (n) => msgOk(n.Message) && has(n.Message.ContentId) && has(n.Message.TargetUserId),
  AddChatThreadMemberListChangedMessage: (n) => !!n.Message && [n.Message.ChatThreadId, n.Message.ChatMessageId, n.Message.Created, n.Message.MessageType, n.Message.SequenceNumber, n.Message.IsAdded].every(has)
    && idsOk(n.Message.MemberUserIds),
  AddChatThreadGameStateMessage: (n) => msgOk(n.Message) && has(n.Message.GameName) && has(n.Message.State),
  UpdateChatThreadGameStateMessage: (n) => msgOk(n.Message) && has(n.Message.State),
  AddChatThreadGameEventMessage: (n) => msgOk(n.Message) && has(n.Message.GameStateMessageId) && has(n.Message.GameName) && has(n.Message.Payload),
  AddFriendshipInvitation: (n) => has(n.Invitation?.FriendDisplayName) && has(n.Invitation?.IsInviter)
    && has(n.Invitation?.FriendshipInvitationId) && has(n.Invitation?.IsTrusted),
  AddFriendship: (n) => has(n.FriendshipInvitationId) && has(n.Friend?.DisplayName) && has(n.Friend?.UserId) && has(n.IsTrusted),
  RemoveFriendshipInvitation: (n) => has(n.InvitationId),
  RemoveFriendship: (n) => has(n.FriendUserId),
  RemoveFriendshipTrust: (n) => has(n.FriendUserId),
  UpdateChatThreadTrustStatus: (n) => has(n.ChatThreadId) && has(n.IsTrusted),
  AddChatThreadNickname: (n) => has(n.ChatThreadNickname?.ChatThreadId) && has(n.ChatThreadNickname?.Nickname),
  RemoveChatThreadNickname: (n) => has(n.ChatThreadId),
  ClearMemberChatHistory: (n) => idsOk(n.ChatThreadIds),
  ClearUnreadMessageCount: (n) => idsOk(n.ChatThreadIds),
  AddAlert: (n) => has(n.Alert?.Text) && has(n.Alert?.AlertId) && has(n.Alert?.Level) && has(n.Alert?.Timestamp),
  ClearAlert: (n) => idsOk(n.AlertIds),
};

// GetNotificationsResponse fields that are not notification lists.
const NON_LISTS = new Set(["Status", "LastNotificationTimestamp", "NotificationSequenceCounter"]);

export class MixClient {
  swid = "";
  accessToken = "";
  sessionId: string | null = null;
  key: Buffer | null = null;
  latest = 0;
  readonly clientId: string;
  /** Where Mix API calls go (mix_platform_services_url); GC stays at base. */
  readonly mixBase: string;

  constructor(readonly base: string, opts: { clientId?: string; mixBase?: string } = {}) {
    this.clientId = opts.clientId ?? "CPI-TEST";
    this.mixBase = opts.mixBase ?? base;
  }

  async login(displayName: string, password: string): Promise<void> {
    const gc = `${this.base}/jgc/v5/client/${this.clientId}`;
    const k = await fetch(`${gc}/api-key`, { method: "POST" });
    const apiKey = k.headers.get("api-key");
    const r = await fetch(`${gc}/guest/login?expand=profile,displayName,marketing`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `APIKEY ${apiKey}` },
      body: JSON.stringify({ loginValue: displayName, password }),
    });
    const body: any = await r.json();
    if (!body?.data?.token?.access_token) throw new Error(`login ${displayName} failed: ${r.status} ${JSON.stringify(body)}`);
    this.swid = body.data.profile.swid;
    this.accessToken = body.data.token.access_token;
  }

  async startSession(): Promise<void> {
    const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
    const jwk = publicKey.export({ format: "jwk" }) as { n: string; e: string };
    const b64 = (s: string) => Buffer.from(s, "base64url").toString("base64");
    const { http, body } = await this.call("PUT", "/session/user", {
      PublicKeyModulus: b64(jwk.n),
      PublicKeyExponent: b64(jwk.e),
    });
    if (http !== 200 || body?.Status !== "OK") throw new Error(`session start failed: ${http} ${JSON.stringify(body)}`);
    // The SDK uses PKCS#1 v1.5 (RsaEncryptor). Bun refuses v1.5 private
    // decryption (Marvin mitigation), so decrypt raw and strip the
    // 00 02 <non-zero padding> 00 prefix here. Test-only code.
    const raw = crypto.privateDecrypt({ key: privateKey, padding: crypto.constants.RSA_NO_PADDING }, Buffer.from(body.EncryptedSymmetricKey, "base64"));
    const sep = raw.indexOf(0, 2);
    if (raw[0] !== 0 || raw[1] !== 2 || sep < 10) throw new Error("bad PKCS#1 v1.5 padding on EncryptedSymmetricKey");
    this.key = raw.subarray(sep + 1);
    this.sessionId = String(body.SessionId);
  }

  async call(method: "PUT" | "POST", path: string, body: object = {}): Promise<{ http: number; body: any }> {
    const json = stringifyJson({ ...body, UserId: this.swid, Timestamp: Date.now() });
    const headers: Record<string, string> = {
      "X-Mix-OneIdToken": this.accessToken,
      "X-Mix-ClientToken": MIX_CLIENT_TOKEN,
    };
    let payload: string | Buffer = json;
    if (this.key && this.sessionId) {
      headers["Content-Type"] = "application/mix";
      headers["X-Mix-UserSessionId"] = this.sessionId;
      payload = encryptAesCbc(Buffer.from(json, "utf8"), this.key);
    } else {
      headers["Content-Type"] = "application/json";
    }
    const r = await fetch(`${this.mixBase}${path}`, { method, headers, body: payload });
    const raw = Buffer.from(await r.arrayBuffer());
    let text = raw.toString("utf8");
    if ((r.headers.get("content-type") ?? "").includes("application/mix") && this.key) {
      text = decryptAesCbc(raw, this.key).toString("utf8");
    }
    let parsed: any = null;
    // Lossless: 64-bit ids (ClientChatMessageId) come back as BigInt.
    try { parsed = parseJson(text); } catch { parsed = text; }
    return { http: r.status, body: parsed };
  }

  async state(): Promise<any> {
    const { http, body } = await this.call("POST", "/state");
    if (http !== 200) throw new Error(`/state failed: ${http} ${JSON.stringify(body)}`);
    this.latest = body.NotificationSequenceCounter ?? 0;
    return body;
  }

  /** One poll, as NotificationPoller.Poll: asks for latest + 1 onward. */
  async poll(): Promise<{ type: string; n: any }[]> {
    const { http, body } = await this.call("POST", "/notifications/sinceSequence", {
      SequenceNumber: this.latest + 1,
      ExcludeNotificationSequenceNumbers: [],
    });
    if (http !== 200) throw new Error(`poll failed: ${http} ${JSON.stringify(body)}`);
    const out: { type: string; n: any }[] = [];
    for (const [type, list] of Object.entries(body ?? {})) {
      if (NON_LISTS.has(type) || !Array.isArray(list)) continue;
      for (const n of list) out.push({ type, n });
    }
    return out.sort((a, b) => a.n.SequenceNumber - b.n.SequenceNumber);
  }

  /** Applies one notification the way the client's queue would. */
  apply(n: any, type: string): boolean {
    const seqOk = typeof n?.SequenceNumber === "number" && n.SequenceNumber !== 0 && n.SequenceNumber === this.latest + 1;
    const validator = REQUIRED[type];
    if (!validator) throw new Error(`no validator for notification type ${type}`);
    if (!seqOk || !validator(n)) return false;
    this.latest = n.SequenceNumber;
    return true;
  }

  /** Polls once and applies everything; throws on any rejection or gap. */
  async drain(): Promise<{ type: string; n: any }[]> {
    const got = await this.poll();
    for (const g of got) {
      if (!this.apply(g.n, g.type)) {
        throw new Error(`${this.swid}: rejected ${g.type} seq=${g.n?.SequenceNumber} (latest ${this.latest}): ${JSON.stringify(g.n)}`);
      }
    }
    const { body } = await this.call("POST", "/notifications/sinceSequence", { SequenceNumber: this.latest + 1, ExcludeNotificationSequenceNumbers: [] });
    if (typeof body?.NotificationSequenceCounter === "number" && body.NotificationSequenceCounter > this.latest) {
      throw new Error(`${this.swid}: gap, server counter ${body.NotificationSequenceCounter} > applied ${this.latest}`);
    }
    return got;
  }
}
