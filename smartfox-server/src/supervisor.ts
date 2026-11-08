// `bun run start:supervised`: runs the game server and starts it again
// whenever it exits with RESTART_EXIT_CODE (an admin's :restart). Any other
// exit ends the supervisor with the same code.
import { RESTART_EXIT_CODE } from "./config.ts";

let child: ReturnType<typeof Bun.spawn> | null = null;
let stopping = false;

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    stopping = true;
    if (child) child.kill(signal);
    else process.exit(0);
  });
}

for (;;) {
  child = Bun.spawn(["bun", "run", `${import.meta.dir}/handshake-server.ts`], {
    env: { ...process.env, ICEBERG_SUPERVISED: "1" },
    stdio: ["inherit", "inherit", "inherit"],
  });
  const code = await child.exited;
  child = null;
  if (stopping || code !== RESTART_EXIT_CODE) process.exit(stopping ? 0 : code);
  console.log(`[${new Date().toISOString()}] [supervisor] restarting`);
}
