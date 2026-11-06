import { getUtfString } from "../wire-helpers.ts";
import type { SFSObjectData } from "../sfs-wire.ts";
import type { HandlerContext } from "./context.ts";

// "task.p" - sent when a collectible is picked up. `id` = item path,
// `t` = collectible type, `p` = position (Vec3). No direct response; the
// server's only follow-up is a "task.c" daily-challenge progress push.
// TODO: feed this into a daily task system.
export function handlePickup(innerParams: SFSObjectData, ctx: HandlerContext): void {
  const id = getUtfString(innerParams, "id");
  const collectibleType = getUtfString(innerParams, "t");
  console.log(`[${new Date().toISOString()}] ${ctx.peer} - task.p pickup (id=${id ?? "?"}, type=${collectibleType ?? "?"}), no task-progress system ported yet`);
}
