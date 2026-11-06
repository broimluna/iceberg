// Entry point - started via `bun start` (package.json). This file
// used to be the whole server; now it's just the bootstrap.
// See server.ts for the per-connection transport/dispatch logic and
// src/handlers/ for the per-command implementations - one file per
// command, the same shape as a Java SFS2X extension's
// addRequestHandler(commandName, HandlerClass) registry.
import { startServer } from "./server.ts";

startServer();
