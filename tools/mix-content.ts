// Builds and imports the Disney Mix asset bundles that iceberg serves to
// source builds of the app (docs/MIX_API.md sections 2 and 10).
//
//   bun tools/mix-content.ts build --project <DisneyMix checkout> [--unity <editor>] [--method <Class.Method>]
//   bun tools/mix-content.ts import --from <…/StreamingAssets/AssetBundles> [--to <dir>]
//
// build runs the Unity editor in batchmode to rebuild the standalonelinux64
// bundles into the project's StreamingAssets/AssetBundles/ (windows64
// ships prebuilt in the client repo). The log goes to <project>-bundles.log.
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
const DEFAULT_UNITY = `${process.env.HOME}/Unity/Hub/Editor/6000.3.14f1/Editor/Unity`;
const DEFAULT_METHOD = "RebuildAssetBundles.RebuildAllBatch";
const USAGE =
  "usage: bun tools/mix-content.ts build --project <path> [--unity <editor>] [--method <Class.Method>]\n" +
  "       bun tools/mix-content.ts import --from <…/StreamingAssets/AssetBundles> [--to <dir>]";

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

/** Exit code for the CLI: 0 ok, 2 Unity license missing, 1 other failure. */
export async function buildBundles(project: string, unity: string, method: string): Promise<number> {
  const log = `${project}-bundles.log`;
  const cmd = [unity, "-batchmode", "-quit", "-nographics", "-projectPath", project,
               "-buildTarget", "Linux64", "-executeMethod", method, "-logFile", log];
  console.log(`running ${cmd.join(" ")}`);
  const started = Date.now();
  const proc = Bun.spawn(cmd, { stdio: ["inherit", "inherit", "inherit"] });
  const code = await proc.exited;
  const secs = Math.round((Date.now() - started) / 1000);
  if (code === 0) {
    console.log(`bundles built in ${secs}s: ${project}/Assets/StreamingAssets/AssetBundles/standalonelinux64/ (log ${log})`);
    return 0;
  }
  if (code === 198) {
    console.error(
      "Unity exited 198: no valid Unity Editor license. The Flatpak Unity Hub keeps the license in its\n" +
      "sandbox; copy it where the native editor looks (docs/MIX_API.md section 5):\n" +
      "  mkdir -p ~/.config/unity3d/Unity/licenses && cp ~/.var/app/com.unity.UnityHub/config/unity3d/Unity/licenses/UnityEntitlementLicense.xml ~/.config/unity3d/Unity/licenses/",
    );
    return 2;
  }
  console.error(`Unity exited ${code} after ${secs}s; see the log: ${log}`);
  return 1;
}

if (import.meta.main) {
  const [cmd, ...args] = process.argv.slice(2);
  if (cmd === "build") {
    const project = arg(args, "--project");
    if (!project || !existsSync(project)) {
      console.error(project ? `--project ${project} does not exist\n${USAGE}` : USAGE);
      process.exit(1);
    }
    process.exit(await buildBundles(resolve(project), arg(args, "--unity") ?? DEFAULT_UNITY, arg(args, "--method") ?? DEFAULT_METHOD));
  } else if (cmd === "import") {
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
