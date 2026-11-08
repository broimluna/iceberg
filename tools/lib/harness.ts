// Shared test harness: runs a throwaway copy of web-api with its own empty
// database (the database path is fixed next to the source), so live data
// is never touched.
import crypto from "node:crypto";
import { mkdtempSync, cpSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO = resolve(import.meta.dir, "../..");
const SRC = `${REPO}/web-api`;

let nextPort = 3990 - (process.pid % 500);

export interface WebApi {
  base: string;
  dbPath: string;
  dir: string;
  logs: () => string;
  /** Kills the server; the promise resolves once the process has exited. */
  stop: () => Promise<unknown>;
  /** Stops the server and starts it again on the same copy and port. */
  restart: (env?: Record<string, string>) => Promise<void>;
  /** Headers for calling /api/internal/* as the game server does (the shared secret). */
  internalHeaders: () => Record<string, string>;
}

export async function startWebApi(opts: {
  port?: number;
  env?: Record<string, string>;
  beforeStart?: (dbPath: string) => void;
} = {}): Promise<WebApi> {
  const top = mkdtempSync(join(tmpdir(), "iceberg-webapi-"));
  const dir = `${top}/web-api`;
  cpSync(`${SRC}/src`, `${dir}/src`, { recursive: true, filter: (p) => !/cpi_data\.db/.test(p) });
  // The Mix bundle tree (~68 MB per platform) is left out; tests that need
  // bundles write their own.
  cpSync(`${SRC}/data`, `${dir}/data`, { recursive: true, filter: (p) => !p.includes("/data/mix/cpipe/AssetBundles") });
  cpSync(`${SRC}/package.json`, `${dir}/package.json`);
  symlinkSync(`${SRC}/node_modules`, `${dir}/node_modules`);
  // routes/task.ts reads ../../../smartfox-server/data, so keep the sibling layout.
  cpSync(`${REPO}/smartfox-server/data`, `${top}/smartfox-server/data`, { recursive: true });
  const dbPath = `${dir}/src/cpi_data.db`;
  opts.beforeStart?.(dbPath);

  // Tests that pair a game server with this web API pass the same key in env.
  const defaultKey = crypto.randomBytes(32).toString("hex");
  const port = opts.port ?? nextPort--;
  const base = `http://127.0.0.1:${port}`;
  let out = "";
  let proc: ReturnType<typeof Bun.spawn> | null = null;

  const launch = async (env: Record<string, string>) => {
    proc = Bun.spawn(["bun", "run", "src/server.ts"], {
      cwd: dir,
      // Auth rate limits are off unless a test turns them on (suites register
      // and log in many accounts from one address), and test accounts made
      // with createPlayer have no password, so their first login sets one.
      env: {
        ...process.env, PORT: String(port),
        AUTH_LOGIN_PER_MIN: "0", AUTH_REGISTER_PER_HOUR: "0", AUTH_APIKEY_PER_MIN: "0", LEGACY_PASSWORD_CLAIM: "1",
        JOIN_SIGNING_KEY: defaultKey,
        ...env,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const pump = async (s: ReadableStream<Uint8Array>) => { for await (const c of s) out += new TextDecoder().decode(c); };
    pump(proc.stdout as ReadableStream<Uint8Array>);
    pump(proc.stderr as ReadableStream<Uint8Array>);
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      try { await fetch(`${base}/`); return; } catch { await Bun.sleep(100); }
    }
    proc.kill();
    throw new Error(`web-api did not start on ${base}:\n${out.slice(-2000)}`);
  };

  let currentEnv: Record<string, string> = opts.env ?? {};
  // Same rule as web-api/src/utils/internalSecret.ts.
  const internalHeaders = () => {
    const key = currentEnv.JOIN_SIGNING_KEY || defaultKey;
    const secret = currentEnv.INTERNAL_API_SECRET || crypto.createHmac("sha256", key).update("iceberg internal api v1").digest("hex");
    return { "Content-Type": "application/json", "X-Internal-Secret": secret };
  };

  let lastExit: Promise<unknown> = Promise.resolve();
  const stop = () => { if (proc) { proc.kill(); lastExit = proc.exited; proc = null; } return lastExit; };
  await launch(opts.env ?? {});
  return {
    base, dbPath, dir,
    logs: () => out,
    stop,
    internalHeaders,
    restart: async (env = opts.env ?? {}) => {
      stop();
      await lastExit;
      currentEnv = env;
      await launch(env);
    },
  };
}

export function makeChecker() {
  let failures = 0;
  return {
    check(cond: boolean, msg: string) {
      console.log(`${cond ? "PASS" : "FAIL"}  ${msg}`);
      if (!cond) failures++;
    },
    finish(logs?: string): never {
      if (failures && logs) console.log(logs.split("\n").filter((l) => /ERROR|Error|error/.test(l)).slice(0, 30).join("\n"));
      console.log(failures === 0 ? "\nALL PASSED" : `\n${failures} FAILURE(S)`);
      process.exit(failures ? 1 : 0);
    },
  };
}

/** A guest-controller API key issued by the server (only issued keys are accepted). */
export async function issueApiKey(base: string): Promise<string> {
  const r = await fetch(`${base}/jgc/v5/client/T/api-key`, { method: "POST" });
  const key = r.headers.get("api-key");
  if (!key) throw new Error(`no api-key issued (${r.status})`);
  return key;
}

const runPasswords = new Map<string, string>();
/** A random password for this run, the same for the same label (no fixed passwords in the repo). */
export function pw(label: string): string {
  let p = runPasswords.get(label);
  if (!p) runPasswords.set(label, (p = `${label}-${crypto.randomBytes(9).toString("base64url")}`));
  return p;
}
