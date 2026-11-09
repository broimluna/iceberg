import { openLobby } from "../party-games/lobby.ts";
import { reply, replyError, type CommandDef } from "./common.ts";

const DANCE_BATTLE_TEMPLATE = 3;

export const commands: CommandDef[] = [
  {
    name: "dancebattle",
    minRole: "moderator",
    usage: ":dancebattle",
    run(_args, ctx) {
      // The lobby appears at the Town stage, so this is meant for a Town room.
      if (openLobby(ctx.session.roomName, DANCE_BATTLE_TEMPLATE)) reply(ctx, "Dance Battle lobby opened");
      else replyError(ctx, "A lobby or game is already running here");
    },
  },
];
