// Builds and imports the Disney Mix asset bundles that iceberg serves to
// source builds of the app (docs/MIX_API.md sections 2 and 10).
//
//   bun tools/mix-content.ts import --from <…/StreamingAssets/AssetBundles> [--to <dir>]
//
// import replaces <to>/AssetBundles/<platform>/ with every hd/**/*.unity3d
// for windows64 and standalonelinux64, then prints what is present against
// what Disney's final manifest (00134) listed. Restart web-api afterwards:
// the bundle tree is scanned at startup.
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { CONTENT_PLATFORMS } from "../web-api/src/services/mixContent.ts";
import manifestFile from "../web-api/data/mix/cpipe-manifest.json";

const DEFAULT_TO = resolve(import.meta.dir, "../web-api/data/mix/cpipe");
const AREAS = ["hd/stickers", "hd/gags", "hd/gogs", "hd/avatar_thumbs", "hd/avatar_multiplane"];
const USAGE = "usage: bun tools/mix-content.ts import --from <…/StreamingAssets/AssetBundles> [--to <dir>]";

function arg(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const f = join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(f));
    else if (e.isFile()) out.push(f);
  }
  return out;
}

/** Area of a path relative to the platform folder, e.g. "hd/stickers/x/y" -> "hd/stickers". */
function areaOf(rel: string): string {
  return AREAS.find((a) => rel.startsWith(a + "/")) ?? "other";
}

function listedCounts(): Record<string, number> {
  const counts: Record<string, number> = Object.fromEntries([...AREAS, "other"].map((a) => [a, 0]));
  const prefix = "AssetBundles/iphone/";
  for (const k of Object.keys((manifestFile as any).manifest.paths)) {
    if (!k.startsWith(prefix + "hd/") || !k.endsWith(".unity3d")) continue;
    counts[areaOf(k.slice(prefix.length))]++;
  }
  return counts;
}

export function importBundles(from: string, to: string): void {
  const listed = listedCounts();
  let any = false;
  for (const platform of CONTENT_PLATFORMS) {
    const src = join(from, platform);
    if (!existsSync(join(src, "hd")) || !statSync(join(src, "hd")).isDirectory()) continue;
    any = true;
    const dest = join(to, "AssetBundles", platform);
    rmSync(dest, { recursive: true, force: true });
    const present: Record<string, number> = Object.fromEntries([...AREAS, "other"].map((a) => [a, 0]));
    for (const f of walk(join(src, "hd"))) {
      if (!f.endsWith(".unity3d")) continue;
      const rel = relative(src, f).split("\\").join("/");
      mkdirSync(dirname(join(dest, rel)), { recursive: true });
      cpSync(f, join(dest, rel));
      present[areaOf(rel)]++;
    }
    console.log(`${platform}:`);
    for (const a of [...AREAS, "other"]) {
      console.log(`  ${a.padEnd(22)} ${present[a]} present / ${listed[a]} listed`);
    }
  }
  if (!any) console.log(`no ${CONTENT_PLATFORMS.join(" or ")} bundles under ${from}`);
  if (!existsSync(join(to, "donotcopy/n7c4c656"))) {
    console.error(
      `warning: ${join(to, "donotcopy/n7c4c656")} is missing. Once the app fetches /cpipe it also\n` +
      `refetches the boot config after every server restart (docs/MIX_API.md section 2), and a 404\n` +
      `there breaks boot. Render it with:\n` +
      `  bun tools/mix-config.ts render <url> --out ${join(to, "donotcopy/n7c4c656")}`,
    );
  }
}

if (import.meta.main) {
  const [cmd, ...args] = process.argv.slice(2);
  if (cmd === "import") {
    const from = arg(args, "--from");
    const to = arg(args, "--to") ?? DEFAULT_TO;
    if (!from || !existsSync(from)) {
      console.error(from ? `--from ${from} does not exist\n${USAGE}` : USAGE);
      process.exit(1);
    }
    importBundles(resolve(from), resolve(to));
  } else {
    console.error(USAGE);
    process.exit(1);
  }
}
