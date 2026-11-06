// Per-connection session state - one instance per client connection.
// Replaces the old hardcoded `const USER_ID = 1` diagnostic-server shortcut
// (handshake-server.ts's original single-file version) with a real
// per-connection id, so a second/returning connection no longer collides
// with a still-open one. Field names mirror what a Java SFS2X extension's
// login handler stores via `session.setProperty(...)` so future
// ports (membership rights, room-owner info, etc.) have an obvious,
// already-typed place to land.
let nextUserId = 1;

export class Session {
  readonly userId: number;
  zoneName = "ClubPenguin";
  roomName = "ClubPenguin_default_room";
  userName = "guest";

  // Captured at Login from the client's own joinRoomData - see
  // handlers/sfs2x/login.ts for how each of these is extracted and why
  // (64-bit sessionId precision hazard, outfit JSON, etc).
  playerSessionId: string | undefined;
  outfitJson: string | undefined;
  colour: number | undefined;
  selectedTubeId: number | undefined;
  // SignedResponse<JoinRoomData>'s own top-level "swid" (sibling of
  // "data", same wrapper shape as every other SignedResponse<T> - see
  // docs/API_ENDPOINTS_DOCUMENTATION.md). Distinct
  // from playerSessionId (that's JoinRoomData.sessionId, nested inside
  // "data").
  swid: string | undefined;

  // Updated by handlers/locomotion.ts on every "l.a" - the only source of
  // truth this server has for where the player actually is, needed by
  // handlers/validation.ts's validate.state (InWorldState.position,
  // ClubPenguinClient.decompiled.cs:9589-9596).
  lastPosition: number[] | undefined;

  // The AES-256 key handlers/encryption.ts generates and RSA-encrypts
  // for the client on encryption.get - stashed here so handlers/chat.ts
  // can decrypt chat.msg once a key's been established, matching the
  // historical server design ("key stored in user session as aesSecret").
  // Without it, encrypted chat.msg traffic can't be decrypted.
  aesKey: Buffer | undefined;

  // Set by handlers/gear.ts's sendEquippedObjectVariable - the
  // server-side-known name of whatever was last equipped via
  // durable.equip/dispensable.equip, needed by validate.state's
  // InWorldState.equippedItem field.
  equippedItemName: string | undefined;

  // Consumed once the client's own first quest.set push proves
  // RewardService/QuestService are actually up and listening - see
  // handlers/quest.ts's sendStarterRewards for why this can't just fire
  // right after Login.
  starterRewardsSent = false;

  // QuestObjectives (SmartfoxCommand.SERVER_OBJECTIVE_COMPLETED's payload)
  // is the *full* running list of completed objective names for the active
  // quest, not just the newest one - see handlers/quest.ts.
  readonly completedObjectives: string[] = [];

  constructor() {
    this.userId = nextUserId++;
  }
}
