import { getUtfString } from "../wire-helpers.ts";
import type { SFSObjectData } from "../sfs-wire.ts";
import type { HandlerContext } from "./context.ts";

// SmartfoxCommand.PICKUP ("task.p", SMARTFOX_PACKETS_DOCUMENTATION.md's
// Tasks section) - OUT only, no documented response: `id` = item path
// (string), `t` = collectible-type tag (string), `p` = position (Vec3).
// The client sends this when a collectible is picked up; the only real
// response the doc confirms is `task.c` (TASK_COUNT) - but that's a
// separate, IN-only push tied to *daily challenge* progress, driven by
// the old recovered extension's DailyTaskManager (~450 lines, its own
// task-definition/progress-tracking system, not ported yet - out of
// scope for this pass). Logging the pickup only; wiring it into a real
// daily-task system is future work, not a guess made now.
export function handlePickup(innerParams: SFSObjectData, ctx: HandlerContext): void {
  const id = getUtfString(innerParams, "id");
  const collectibleType = getUtfString(innerParams, "t");
  console.log(`[${new Date().toISOString()}] ${ctx.peer} - task.p pickup (id=${id ?? "?"}, type=${collectibleType ?? "?"}), no task-progress system ported yet`);
}
