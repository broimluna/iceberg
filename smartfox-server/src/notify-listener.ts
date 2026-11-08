import http from "node:http";
import { SFSObjectWriter, encodePacket } from "./sfs-wire.ts";
import { getByUsername } from "./session-registry.ts";
import { NOTIFY_PORT } from "./config.ts";
import { internalRequestStatus } from "./internal-secret.ts";

const MAX_BODY_BYTES = 64 * 1024;

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
    const status = internalRequestStatus(req);
    if (status !== 200) {
      res.writeHead(status).end();
      return;
    }
    let body = "";
    let tooBig = false;
    req.on("data", (chunk) => {
      if (tooBig) return;
      body += chunk;
      if (body.length > MAX_BODY_BYTES) {
        tooBig = true;
        res.writeHead(413).end();
        req.destroy();
      }
    });
    req.on("end", () => {
      if (tooBig) return;
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
  // Only web-api on this machine calls it.
  server.listen(NOTIFY_PORT, "127.0.0.1", () => {
    console.log(`WebAPI notify listener on 127.0.0.1:${NOTIFY_PORT} (POST /notify)`);
  });
}
