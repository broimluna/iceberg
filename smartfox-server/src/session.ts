import type { Protocol } from "./sfs-wire.ts";
import type { Role } from "./commands/roles.ts";

// Per-connection state, one per connected client.
let nextUserId = 1;

export class Session {
  readonly userId: number;
  // Wire protocol, detected from the connection's first packet (server.ts).
  protocol: Protocol = "sfs2x";
  zoneName = "ClubPenguin";
  roomName = "ClubPenguin_default_room";
  userName = "guest";

  // Taken from the client's joinRoomData at login (see handlers/sfs2x/login.ts).
  playerSessionId: string | undefined;
  outfitJson: string | undefined;
  colour: number | undefined;
  selectedTubeId: number | undefined;
  // The top-level swid of SignedResponse<JoinRoomData>.
  swid: string | undefined;
  // Whether joinRoomData's signature checked out (false only with
  // SFS_ALLOW_UNSIGNED_LOGIN). The login's "un" is never signed.
  signedLogin = false;
  // The web API account behind the swid, and its staff role. Set once
  // identityReady resolves (account.ts); rewards and tasks are credited to
  // accountName, never to userName.
  accountName: string | undefined;
  role: Role = "player";
  identityReady: Promise<void> = Promise.resolve();

  // Last position reported via l.a.
  lastPosition: number[] | undefined;

  // AES key from encryption.get, used to decrypt chat.msg.
  aesKey: Buffer | undefined;

  // Name of the last equipped item, for validate.state.
  equippedItemName: string | undefined;

  // Consumable the client equipped through its own "con" user variable
  // ({type: "consum", name}). Carried across rooms by transient-data.ts.
  equippedConsumable: string | undefined;
  // actionCount in the "con_prop" variable, set while holding a tray or an
  // item taken from one.
  heldActionCount: number | undefined;
  // NameOnServer of whatever is in "con" (consumable, gear or dispensable).
  heldObject: string | undefined;
  // "loc" user variable: Domain.LocomotionState byte (0 when cleared).
  locomotionState = 0;
  // Path of the last LOCAL object the player interacted with (l.a Interact).
  lastInteraction: string | undefined;
  // When this player last took an item from someone's tray (ms).
  lastTakeAt = 0;

  // See sendStarterRewards in handlers/quest.ts.
  starterRewardsSent = false;

  // Every objective completed in the active quest (quest.s_obj sends the full list).
  readonly completedObjectives: string[] = [];

  constructor() {
    this.userId = nextUserId++;
  }
}
