import { startGameNow } from "../island-targets/playground.ts";
import { reply, replyError, type CommandDef } from "./common.ts";

export const commands: CommandDef[] = [
  {
    name: "crateco",
    minRole: "moderator",
    usage: ":crateco",
    run(_args, ctx) {
      const result = startGameNow(ctx.session.roomName);
      if (result === "started") reply(ctx, "Crate Co targets started");
      else if (result === "running") replyError(ctx, "A Crate Co game is already running here");
      else replyError(ctx, "Crate Co targets run on Mt Blizzard");
    },
  },
];
