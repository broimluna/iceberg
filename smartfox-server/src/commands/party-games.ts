import { openLobby, zoneOf } from "../party-games/lobby.ts";
import { reply, replyError, usage, type CommandDef } from "./common.ts";

const DANCE_BATTLE_TEMPLATE = 3;
const TUBE_RACES: Record<string, { template: number; name: string }> = {
  red: { template: 4, name: "Red" },
  blue: { template: 5, name: "Blue" },
};
const TUBE_RACE_ZONE = "MtBlizzard";

const tuberace: CommandDef = {
  name: "tuberace",
  minRole: "moderator",
  usage: ":tuberace red|blue",
  run(args, ctx) {
    const race = TUBE_RACES[(args[0] ?? "").toLowerCase()];
    if (!race) return usage(ctx, tuberace);
    // The lobbies and the course are in the Mt Blizzard scene.
    if (zoneOf(ctx.session.roomName) !== TUBE_RACE_ZONE) return replyError(ctx, "Tube races run on Mt Blizzard");
    if (openLobby(ctx.session.roomName, race.template)) reply(ctx, `${race.name} tube race lobby opened`);
    else replyError(ctx, "A lobby or game is already running here");
  },
};

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
  tuberace,
];
