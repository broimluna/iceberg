// Mix content delivery (docs/MIX_API.md sections 2 and 10): web-api scans
// data/mix/cpipe/AssetBundles/{windows64,standalonelinux64}/ at startup and
// lists every bundle in the /cpipe manifest, so source builds of the app
// can download stickers and gags from cdnRoot.
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, existsSync } from "node:fs";
import { $ } from "bun";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { startWebApi, makeChecker } from "./lib/harness.ts";
import { scanContent } from "../web-api/src/services/mixContent.ts";
import manifestFile from "../web-api/data/mix/cpipe-manifest.json";

const { check, finish } = makeChecker();
const AUTH = { Authorization: "GAE 01D93B3F-8532-4A91-81E7-558BE3600600" };
const WIN_KEY = "AssetBundles/windows64/hd/stickers/a/a_hd.unity3d";
const LINUX_KEY = "AssetBundles/standalonelinux64/hd/gags/g/g_hd.unity3d";
const basePaths: Record<string, any> = (manifestFile as any).manifest.paths;

const put = (root: string, rel: string, body: string) => {
  const f = join(root, rel);
  mkdirSync(dirname(f), { recursive: true });
  writeFileSync(f, body);
  return f;
};

let logs = "";
try {
  // --- scanContent, on a temp tree ---
  const tmp = mkdtempSync(join(tmpdir(), "mix-content-"));
  check(JSON.stringify(scanContent(join(tmp, "missing"))) === "{}", "missing root -> {}");

  const win = put(tmp, WIN_KEY, "hello");
  utimesSync(win, 1700000000, 1700000000);
  put(tmp, WIN_KEY + ".meta", "meta");
  put(tmp, LINUX_KEY, "gag");
  put(tmp, "AssetBundles/android/hd/x.unity3d", "android");
  const scanned = scanContent(tmp);
  const keys = Object.keys(scanned).sort();
  check(JSON.stringify(keys) === JSON.stringify([LINUX_KEY, WIN_KEY].sort()), `scan keys ${JSON.stringify(keys)}`);
  check(keys.every((k) => !k.includes("\\") && !k.endsWith("/")), "keys use forward slashes only");
  check(JSON.stringify(scanned[WIN_KEY]) === JSON.stringify({ crc: "3610A686", v: 1700000000 }), `windows entry ${JSON.stringify(scanned[WIN_KEY])}`);

  // --- /cpipe with a content tree ---
  const api = await startWebApi({
    beforeStart: (dbPath) => {
      const root = join(dirname(dirname(dbPath)), "data/mix/cpipe");
      utimesSync(put(root, WIN_KEY, "hello"), 1700000000, 1700000000);
    },
  });
  try {
    const body: any = await (await fetch(`${api.base}/cpipe?restrict=true&cv=2.3`, { headers: AUTH })).json();
    const paths = body?.manifest?.paths ?? {};
    check(JSON.stringify(paths[WIN_KEY]) === JSON.stringify({ crc: "3610A686", v: 1700000000 }), `/cpipe entry ${JSON.stringify(paths[WIN_KEY])}`);
    const iphoneKey = Object.keys(basePaths).find((k) => k.startsWith("AssetBundles/iphone/hd/stickers/") && k.endsWith(".unity3d"))!;
    check(JSON.stringify(paths[iphoneKey]) === JSON.stringify(basePaths[iphoneKey]), `base iphone entry unchanged (${iphoneKey})`);
    check(body?.manifest?.cdnRoot === `${api.base}/cpipe/files`, `cdnRoot ${body?.manifest?.cdnRoot}`);
    const f = await fetch(`${api.base}/cpipe/files/1700000000/${WIN_KEY}`);
    check(f.status === 200 && (await f.text()) === "hello", `bundle download -> ${f.status}`);
    const trav = await fetch(`${api.base}/cpipe/files/1700000000/AssetBundles/windows64/..%2f..%2f..%2f..%2fsrc%2fserver.ts`);
    check(trav.status === 404, `traversal from the bundle tree -> ${trav.status}`);
    logs += api.logs();
  } finally { await api.stop(); }

  // --- /cpipe without a content tree: today's manifest ---
  const bare = await startWebApi();
  try {
    const body: any = await (await fetch(`${bare.base}/cpipe?restrict=true&cv=2.3`, { headers: AUTH })).json();
    const n = Object.keys(body?.manifest?.paths ?? {}).length;
    check(n === Object.keys(basePaths).length, `no tree: ${n} paths = base ${Object.keys(basePaths).length}`);
    check((bare.logs().match(/\[CPIPE\].*AssetBundles/g) ?? []).length === 1, "no tree: one [CPIPE] log line");
    logs += bare.logs();
  } finally { await bare.stop(); }

  // --- tools/mix-content.ts import ---
  const from = mkdtempSync(join(tmpdir(), "mix-from-"));
  const to = mkdtempSync(join(tmpdir(), "mix-to-"));
  put(from, "windows64/hd/stickers/s1/s1_hd.unity3d", "s1");
  put(from, "windows64/hd/stickers/s1/s1_hd.unity3d.meta", "meta");
  put(from, "windows64/hd/gags/g1/g1_hd.unity3d", "g1");
  put(to, "AssetBundles/windows64/hd/stickers/old/old_hd.unity3d", "old");
  const imp = await $`bun tools/mix-content.ts import --from ${from} --to ${to}`.nothrow().quiet();
  const out = imp.stdout.toString() + imp.stderr.toString();
  check(imp.exitCode === 0, `import exit ${imp.exitCode}`);
  check(existsSync(`${to}/AssetBundles/windows64/hd/stickers/s1/s1_hd.unity3d`) && existsSync(`${to}/AssetBundles/windows64/hd/gags/g1/g1_hd.unity3d`), "import copies bundles");
  check(!existsSync(`${to}/AssetBundles/windows64/hd/stickers/s1/s1_hd.unity3d.meta`), "import skips .meta");
  check(!existsSync(`${to}/AssetBundles/windows64/hd/stickers/old/old_hd.unity3d`), "import removes a stale bundle");
  check(/hd\/stickers\s+1 present \/ \d+ listed/.test(imp.stdout.toString()), `import summary:\n${imp.stdout.toString()}`);
  check(out.includes("donotcopy/n7c4c656"), "import warns about the missing boot config");
  const noFrom = await $`bun tools/mix-content.ts import`.nothrow().quiet();
  check(noFrom.exitCode === 1, `import without --from exit ${noFrom.exitCode}`);
} catch (e) {
  check(false, `threw: ${(e as Error).stack}`);
}
finish(logs);
