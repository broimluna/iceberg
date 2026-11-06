// Entry point (`bun start`). Transport and dispatch live in server.ts;
// per-command handlers live in src/handlers/.
import { startServer } from "./server.ts";

startServer();
