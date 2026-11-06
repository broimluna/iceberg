import http from "node:http";
import { SFSObjectWriter, encodePacket } from "./sfs-wire.ts";
import { getByUsername } from "./session-registry.ts";
import { NOTIFY_PORT, INTERNAL_API_SECRET } from "./config.ts";

// Receives pushes from the WebAPI (web-api/src/smartfoxNotifier.ts →
// POST /notify) and forwards them to the connected player. Only
// DAILY_TASK_UPDATE has a known client-side packet ("task.c": t = task id,
// c = counter); other notification types are logged.
function handleNotification(payload: Record<string, unknown>): void {
  const type = typeof payload.type === "string" ? payload.type : undefined;
  const username = typeof payload.username === "string" ? payload.username : undefined;
  if (!type || !username) {
    console.log(`[${new Date().toISOString()}] notify-listener: malformed payload ${JSON.stringify(payload)}`);
    return;
  }
  const target = getByUsername(username);
  if (!target) {
    console.log(`[${new Date().toISOString()}] notify-listener: ${type} for ${username}, not currently connected, dropping`);
    return;
  }
  if (type === "DAILY_TASK_UPDATE" && typeof payload.taskId === "string" && typeof payload.counter === "number") {
    const taskCountP = new SFSObjectWriter().putUtfString("t", payload.taskId).putInt("c", payload.counter);
    target.send(encodePacket(1, 13, new SFSObjectWriter().putUtfString("c", "task.c").putSFSObject("p", taskCountP)));
    console.log(`[${new Date().toISOString()}] notify-listener: pushed task.c to ${username} (taskId=${payload.taskId}, counter=${payload.counter})`);
  } else {
    console.log(`[${new Date().toISOString()}] notify-listener: ${type} for ${username} received, no confirmed wire push for this type yet, not forwarded`);
  }
}

export function startNotifyListener(): void {
  const server = http.createServer((req, res) => {
    if (req.method !== "POST" || req.url !== "/notify") {
      res.writeHead(404).end();
      return;
    }
    // Localhost only, plus the optional shared secret.
    const remote = req.socket.remoteAddress ?? "";
    if (remote !== "127.0.0.1" && remote !== "::1" && remote !== "::ffff:127.0.0.1") {
      res.writeHead(403).end();
      return;
    }
    if (INTERNAL_API_SECRET && req.headers["x-internal-secret"] !== INTERNAL_API_SECRET) {
      res.writeHead(401).end();
      return;
    }
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      try {
        handleNotification(JSON.parse(body));
        res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ success: true }));
      } catch (err) {
        console.log(`[${new Date().toISOString()}] notify-listener: bad request body: ${(err as Error).message}`);
        res.writeHead(400).end();
      }
    });
  });
  server.on("error", (err) => {
    console.error(`notify-listener error on port ${NOTIFY_PORT}: ${err.message}`);
  });
  server.listen(NOTIFY_PORT, () => {
    console.log(`WebAPI notify listener on tcp:${NOTIFY_PORT} (POST /notify)`);
  });
}
