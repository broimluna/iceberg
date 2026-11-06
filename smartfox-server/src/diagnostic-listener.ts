// Raw diagnostic TCP listener - NOT a protocol implementation.
//
// Purpose: something to point the retail client's `GameServerHost`
// (via a Tweaker override) at, so a live run shows exactly what the
// client sends - questions no amount of decompiling can answer on its
// own (does OfflineMode ever attempt an SFS2X connection for room-join
// at all? what port does the client actually try?).
//
// Deliberately does NOT attempt to decode SFS2X's real BitSwarm packet
// framing (Sfs2X.Bitswarm.BitSwarmClient / Sfs2X.Core.PacketHeader /
// SFSProtocolCodec in the decompiled client) - that's real, substantial
// wire-protocol work that hasn't been done yet (see the open-questions
// doc). This just proves a connection arrived and dumps exactly what
// bytes came with it, honestly, without guessing at a framing we
// haven't verified.

import net from "node:net";

const PORT = Number(process.env.SFS_TCP_PORT ?? 9933);
// 9933 confirmed live 2026-09-14: a Wine run with GameServerHost=127.0.0.1
// via Tweaker produced 4 SYN packets to 127.0.0.1:9933 (packet capture),
// all RST since nothing listened there at the time (listener was still on
// the old 9339 guess).

const server = net.createServer((socket) => {
  const peer = `${socket.remoteAddress}:${socket.remotePort}`;
  const opened = new Date().toISOString();
  console.log(`[${opened}] connection from ${peer}`);

  socket.on("data", (chunk: Buffer) => {
    const ts = new Date().toISOString();
    console.log(`[${ts}] ${peer} -> ${chunk.length} bytes`);
    console.log(chunk.toString("hex").match(/../g)?.join(" ") ?? "");
    // Best-effort ASCII alongside the hex, for anything that's plain text
    // (SFS2X payloads are mostly binary-framed SFSObject, but worth
    // having both views while we don't have a real decoder yet).
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
