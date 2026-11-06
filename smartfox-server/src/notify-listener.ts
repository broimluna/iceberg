import http from "node:http";
import { SFSObjectWriter, encodePacket } from "./sfs-wire.ts";
import { getByUsername } from "./session-registry.ts";
import { NOTIFY_PORT, INTERNAL_API_SECRET } from "./config.ts";

// Receiving end of a contract the WebAPI already calls
// (web-api/src/smartfoxNotifier.ts's sendNotification, POSTing to
// localhost:9339/notify from routes/catalog.ts and routes/player.ts) -
// nothing to design here, this server just never had anything listening
// on the other end until now. Lets the WebAPI push real-time updates to a
// connected player (e.g. a daily task advancing via a web-only action)
// without the game client having to poll for it.
//
// `TASK_COUNT` ("task.c") is the one push with a decompiled-confirmed
// wire shape (SMARTFOX_PACKETS_DOCUMENTATION.md's Tasks section: `t` =
// task ID string, `c` = counter int, native SFSObject fields, not
// JSON-wrapped like most of this protocol) - COINS_UPDATE/ASSET_ADDED
// have no confirmed client-facing push shape yet, so they're logged, not
// guessed into a wire packet.
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
    // Localhost-only by design - see config.ts's own comment. Same
    // posture as web-api/src/server.ts's /api/internal/add-coins
    // ("no authentication required"), matched rather than tightened
    // unilaterally on this side alone.
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
