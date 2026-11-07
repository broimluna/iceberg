// Per-connection state, one per connected client.
let nextUserId = 1;

export class Session {
  readonly userId: number;
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

  // Last position reported via l.a.
  lastPosition: number[] | undefined;

  // AES key from encryption.get, used to decrypt chat.msg.
  aesKey: Buffer | undefined;

  // Name of the last equipped item, for validate.state.
  equippedItemName: string | undefined;

  // Consumable the client equipped through its own "con" user variable
  // ({type: "consum", name}). Carried across rooms by transient-data.ts.
  equippedConsumable: string | undefined;

  // See sendStarterRewards in handlers/quest.ts.
  starterRewardsSent = false;

  // Every objective completed in the active quest (quest.s_obj sends the full list).
  readonly completedObjectives: string[] = [];

  constructor() {
    this.userId = nextUserId++;
  }
}
