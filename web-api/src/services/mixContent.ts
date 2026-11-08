/**
 * Mix content bundles on disk (docs/MIX_API.md sections 2 and 10).
 *
 * The recreation's bundled cpipe manifest lists only android and iphone
 * bundles, but desktop source builds ask for their own platform folder.
 * iceberg serves the rebuilt desktop bundles (filled by
 * `bun tools/mix-content.ts import`) and lists each file it has, so the
 * manifest never promises content that isn't there.
 *
 * Entry format follows Disney's manifest: `crc` is CRC32 as 8 uppercase
 * hex digits, `v` is the version the client puts in the download URL and
 * uses as its Unity cache version. `v` is the file's mtime, so a changed
 * bundle after a re-import invalidates old caches.
 */
import { readdirSync, readFileSync, statSync } from "fs";

export const CONTENT_PLATFORMS = ["windows64", "standalonelinux64"] as const;
export type ManifestEntry = { crc: string; v: number };

/** Manifest entries for every bundle under `root/AssetBundles/<platform>/`. */
export function scanContent(root: string): Record<string, ManifestEntry> {
    const out: Record<string, ManifestEntry> = {};
    const walk = (dir: string, key: string) => {
        for (const e of readdirSync(dir, { withFileTypes: true })) {
            if (e.name.endsWith(".meta")) continue;
            const file = `${dir}/${e.name}`;
            const k = `${key}/${e.name}`;
            if (e.isDirectory()) walk(file, k);
            else if (e.isFile()) {
                const crc = Bun.hash.crc32(readFileSync(file)).toString(16).toUpperCase().padStart(8, "0");
                out[k] = { crc, v: Math.floor(statSync(file).mtimeMs / 1000) };
            }
        }
    };
    try {
        readdirSync(`${root}/AssetBundles`);
    } catch {
        console.log(`[CPIPE] no content tree at ${root}/AssetBundles; serving the base manifest`);
        return out;
    }
    for (const platform of CONTENT_PLATFORMS) {
        const dir = `${root}/AssetBundles/${platform}`;
        try {
            if (!statSync(dir).isDirectory()) continue;
        } catch { continue; }
        try {
            walk(dir, `AssetBundles/${platform}`);
        } catch (e) {
            console.log(`[CPIPE] could not read ${dir}: ${(e as Error).message}`);
        }
    }
    return out;
}
