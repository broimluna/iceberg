import { getAll } from "../session-registry.ts";
import { RESTART_EXIT_CODE } from "../config.ts";
import { notifyAll, notifyRestarting } from "./notify.ts";
import { DISCONNECT_IDLE, disconnectPacket } from "./moderation.ts";
import { reply, replyError, usage, type CommandDef } from "./common.ts";

const DEFAULT_RESTART_SECONDS = 30;
// A day. Timers longer than 2^31-1 ms overflow and fire at once.
const MAX_RESTART_SECONDS = 86_400;

/** Seconds-remaining marks to announce at: the start, each whole minute, then 30, 10 and 3. */
export function restartMarks(total: number): number[] {
  const marks = new Set<number>([total]);
  for (let m = Math.floor((total - 1) / 60) * 60; m >= 60; m -= 60) marks.add(m);
  for (const m of [30, 10, 3]) if (m < total) marks.add(m);
  return [...marks].sort((a, b) => b - a);
}

export function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60), s = seconds % 60;
  const part = (n: number, unit: string) => `${n} ${unit}${n === 1 ? "" : "s"}`;
  if (m && s) return `${part(m, "minute")} ${part(s, "second")}`;
  return m ? part(m, "minute") : part(s, "second");
}

let timers: ReturnType<typeof setTimeout>[] = [];

function cancelRestart(): boolean {
  const had = timers.length > 0;
  for (const t of timers) clearTimeout(t);
  timers = [];
  return had;
}

function shutDown(): void {
  for (const entry of getAll()) entry.send(disconnectPacket(DISCONNECT_IDLE));
  setTimeout(() => { for (const entry of getAll()) entry.close(); }, 100);
  setTimeout(() => process.exit(RESTART_EXIT_CODE), 1000);
}

function scheduleRestart(total: number): void {
  cancelRestart();
  restartMarks(total).forEach((left, i) => {
    const text = `Server restarting in ${formatDuration(left)}`;
    timers.push(setTimeout(() => (i === 0 ? notifyRestarting(text) : notifyAll(text)), (total - left) * 1000));
  });
  timers.push(setTimeout(shutDown, total * 1000));
}

export const commands: CommandDef[] = [
  {
    name: "admin-alert",
    minRole: "admin",
    usage: ":admin-alert <text>",
    run(args, ctx) {
      if (args.length === 0) return usage(ctx, this);
      notifyAll(args.join(" "));
    },
  },
  {
    name: "restart",
    minRole: "admin",
    usage: `:admin-swre-restart [seconds 1-${MAX_RESTART_SECONDS}, default ${DEFAULT_RESTART_SECONDS}] | :admin-swre-restart cancel`,
    run(args, ctx) {
      if (args.length > 1) return usage(ctx, this);
      if (args[0]?.toLowerCase() === "cancel") {
        if (!cancelRestart()) return replyError(ctx, "No restart is scheduled");
        notifyAll("Server restart cancelled");
        return;
      }
      if (args[0] !== undefined && !/^\d+$/.test(args[0])) return usage(ctx, this);
      const seconds = args[0] === undefined ? DEFAULT_RESTART_SECONDS : Number(args[0]);
      if (seconds < 1 || seconds > MAX_RESTART_SECONDS) return usage(ctx, this);
      const supervised = process.env.ICEBERG_SUPERVISED === "1";
      reply(ctx, `Restarting in ${seconds} s${supervised ? "" : " (not supervised: the server will stop, not restart)"}`);
      scheduleRestart(seconds);
    },
  },
];
