// Raw TCP byte logger for protocol work (`bun run diagnostic`). Point a client
// at it to see exactly what it sends: hex plus printable ASCII. No decoding.
import net from "node:net";

const PORT = Number(process.env.SFS_TCP_PORT ?? 9933);
const server = net.createServer((socket) => {
  const peer = `${socket.remoteAddress}:${socket.remotePort}`;
  const opened = new Date().toISOString();
  console.log(`[${opened}] connection from ${peer}`);

  socket.on("data", (chunk: Buffer) => {
    const ts = new Date().toISOString();
    console.log(`[${ts}] ${peer} -> ${chunk.length} bytes`);
    console.log(chunk.toString("hex").match(/../g)?.join(" ") ?? "");
    console.log(
      Array.from(chunk)
        .map((b) => (b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : "."))
        .join("")
    );
  });

  socket.on("close", (hadError) => {
    console.log(`[${new Date().toISOString()}] ${peer} closed (error=${hadError})`);
  });

  socket.on("error", (err) => {
    console.log(`[${new Date().toISOString()}] ${peer} socket error: ${err.message}`);
  });
});

server.on("error", (err) => {
  console.error(`listener error: ${err.message}`);
  process.exit(1);
});

server.listen(PORT, () => {
  console.log(`diagnostic SFS2X listener on tcp:${PORT} (raw bytes only, no protocol decode)`);
});
