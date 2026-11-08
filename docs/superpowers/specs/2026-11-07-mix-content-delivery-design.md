# Disney Mix content delivery (stickers and gags): design

- **Date:** 2026-11-07
- **Status:** awaiting review
- **Repos:** iceberg (this repo) and the Mix client,
  [OpenCPIsland/DisneyMix](https://github.com/OpenCPIsland/DisneyMix)
  (local checkout `~/src/DisneyMix`)

Background, with client citations, is in
[`docs/MIX_API.md`](../../MIX_API.md) §2 (cpipe) and §10 (content
preservation, "Content delivery in source builds"). This spec only
decides what we build.

## Goal

In a Disney Mix app built from source, the sticker and gag panels show
the content we have, and sending a sticker or gag shows it on both
sides. Text chat already works end to end. The server already accepts
and relays sticker and gag messages (`PUT /chatThread/stickerMessage`,
`/gagMessage`). What's missing is the content itself reaching the app.

### Why it doesn't work today

1. The recreation stubbed the manifest loader:
   `CpipeFileManifestLoader.Load` always uses the bundled manifest, and
   Disney's network fetcher `CpipeManifestApi.GetCpipeManifest` has no
   callers. iceberg's `/cpipe` is never requested.
2. The bundled manifest has `cdnRoot: ""` and lists only `android` and
   `iphone` paths. Desktop builds ask for `AssetBundles/iphone/…`, but
   the rebuilt bundles exist only as `windows64`.
3. `ContentData.cs:71` builds the catalog path with `"\\"`, so on Linux
   the catalog (sticker packs, gags, games) never loads.

### Decisions already made

| Decision | Choice |
|---|---|
| Client changes | Patch the client in `~/src/DisneyMix` and prepare the changes as a PR to OpenCPIsland. A server-only fix is impossible (cause 1). |
| Scope | Content delivery, stickers and gags. In-chat games come next, in their own spec. |
| Target clients | Native Linux and Windows source builds. macOS later. |
| Content source | iceberg serves bundles over HTTP through its cpipe manifest and `cdnRoot`, as Disney's CDN did. Content can then be added server-side with no client rebuild. |
| Missing content | Hidden. iceberg lists only bundles it has, and the client drops catalog items whose bundle it can't get. |
| Approach | A: restore the client's network manifest fetch (rejected: B, `cdnRoot` from the boot config with the bundled manifest; C, server picks the bundle by User-Agent). |

### Non-goals

- In-chat games: the `GAME_STATE`/`GAME_EVENT` endpoints. Game bundles
  (`hd/gogs`) are imported and served by the same pipeline, but nothing
  here makes games playable.
- Recovering lost content (412 stickers, 24 gags). That's preservation
  work (MIX_API §10, "Better leads").
- macOS (`standalonemacos`) bundles.
- Rebuilding `windows64` bundles. They ship prebuilt in the client repo.
- Retail Mix builds.

## Architecture

```
 Mix client (source build)                    iceberg web-api
 ─────────────────────────                    ───────────────
 CpipeFileManifestLoader.Load
   └─ CpipeManifestApi.GetCpipeManifest ──►  GET /cpipe
        ok   → PrepareManifest(json)          base manifest 00134
        fail → PrepareManifest(bundled)       + entries for files on disk:
                                                AssetBundles/windows64/…
 ContentData.ParseJoeData                       AssetBundles/standalonelinux64/…
   └─ drop Sticker/Gag not available          cdnRoot = <origin>/cpipe/files
      (not in manifest, not in
       StreamingAssets); drop empty packs
                                                       ▲
 AssetManager.GetCpipePrefix                           │ startup scan
   AssetBundles/<GetBundlePlatform()>/hd/…   services/mixContent.ts
   → cdnRoot/<v>/<path>  ──────────────────►  GET /cpipe/files/<v>/<path>
                                              data/mix/cpipe/AssetBundles/…
                                                       ▲
                                                       │ copies
                                              tools/mix-content.ts import
                                                       ▲
                                              ~/src/DisneyMix/Assets/
                                                StreamingAssets/AssetBundles/
                                                  windows64/ (prebuilt)
                                                  standalonelinux64/
                                                    (tools/mix-content.ts build)
```

## Components

### Client (`~/src/DisneyMix`, for the OpenCPIsland PR)

Paths are under `Assets/Scripts/Assembly-CSharp/`.

**1. Manifest fetch** (`Mix/CpipeFileManifestLoader.cs`)
- `Load()` calls `Singleton<CpipeManifestApi>.Instance.GetCpipeManifest(…)`
  with the loader as the callback object, passing the cache policy and
  `oldVersion` it already receives. That request is
  `GET {cpipe_url}?restrict=true&cv=…[&v=…]` and caches the response
  under the `cpipeManfiest` key, so the next boot's
  `PreloadData.PreloadCpipeManifest` picks it up.
- `TextReady` keeps its handling: 304 → `onComplete(false)`, a body →
  `PrepareManifest(text, false)`.
- Every failure path (empty body, error status, or `Prepare` returning
  false on bad JSON) falls back to `PrepareManifest(null, true)`, the
  bundled or cached manifest, instead of calling `onError`. `onError`
  is called only if the fallback also fails. A build with no server
  boots exactly as today.

**2. Bundle platform** (`Mix/Assets/AssetManager.cs`,
`Mix/SettingsManager.cs`, `Mix/Assets/BackgroundLoader.cs`)
- One compile-time constant in `AssetManager` names the platform folder:
  `android`, `iphone`, `windows64`, `standalonelinux64` (was
  `standalonelinux`, a folder nothing writes), `standalonemacos`.
  `BundleFolder` is built from it.
- New `SettingsManager.GetBundlePlatform()` returns that constant.
  `AssetManager.GetCpipePrefix` and `BackgroundLoader` use it in place of
  `GetDeviceString()`.
- `GetDeviceString()` is unchanged (still `iphone` on desktop), because
  other code may rely on it.

**3. Catalog path** (`Mix/Data/ContentData.cs:71`)
- `Path.Combine(Application.streamingAssetsPath, "contentdata.joe")`
  replaces `Application.StreamingAssetsPath + "\\"` + filename.
- The `GetStreamingFilePath` fallback (which drops `file://`) is left
  alone: bundle URLs now take its main branch, and text-file callers
  expect a bare path from the fallback. It's revisited only if the live
  check shows a remaining failure.

**4. Hide unavailable content** (`Mix/Data/ContentData.cs`, after
`ParseJoeData`)
- A sticker or gag is *available* when the bundle at `GetHd()`, after
  `GetCpipePrefix`, is listed in the loaded manifest **or** exists in the
  build's StreamingAssets.
- Unavailable `Sticker` and `Gag` entries are removed from `Data`.
  `Sticker_Pack` entries with no remaining stickers are removed.
- The local check keeps a Windows build's bundled `windows64` stickers
  visible even with no server.

**5. Batch entry point** (`Assets/Editor/RebuildAssetBundles.cs`), only
if needed
- If `-executeMethod RebuildAssetBundles.RebuildAll` isn't batchmode-safe
  (it opens dialogs or exits 0 on failure), add `RebuildAllBatch()`,
  which calls it and exits non-zero on failure.

### iceberg: `web-api/src/services/mixContent.ts` (new)

- `scanContent(root)` walks `root/AssetBundles/<platform>/` for
  `windows64` and `standalonelinux64`. For every file it returns a
  manifest entry keyed `AssetBundles/<platform>/<rest>` (forward
  slashes):
  - `crc`: CRC32 of the contents, 8 uppercase hex digits (Disney's
    format)
  - `v`: the file's mtime in whole Unix seconds. The client uses `v` as
    its Unity cache version, so a re-imported, changed bundle
    invalidates old caches.
- A missing or unreadable root logs one line and returns no entries.
- The root is a parameter so tests can use a temp tree.

### iceberg: `web-api/src/routes/cpipe.ts` (changed)

- At startup, `scanContent(FILES_ROOT)` runs once and the result is kept.
- `GET /cpipe` merges those entries into the cloned base manifest's
  `paths`. Existing `android`/`iphone` entries are untouched. `cdnRoot`
  and the config-version handling are unchanged.
- `GET /cpipe/files/*` is unchanged. It already strips the version
  segment, blocks traversal and serves from `data/mix/cpipe/`.
- New bundles appear after an import and a server restart, the same
  rule the boot config already follows.

### iceberg: content tree

- `web-api/data/mix/cpipe/AssetBundles/` is git-ignored, like
  `donotcopy/`. The bundles are Disney assets rebuilt by the recreation,
  about 68 MB per platform. Each deployment fills the tree with the
  import tool.

### iceberg: `tools/mix-content.ts` (new)

`build --project <path> [--unity <editor>]`
- Runs `<editor> -batchmode -quit -nographics -projectPath <path>
  -buildTarget Linux64 -executeMethod RebuildAssetBundles.RebuildAll
  -logFile <path>-bundles.log` (or `RebuildAllBatch`, see client item 5).
- The editor defaults to `~/Unity/Hub/Editor/6000.3.14f1/Editor/Unity`.
- Exit code 198 gets a message pointing at the Unity license copy step
  (MIX_API, native build notes). Any other non-zero exit prints the log
  path.
- Output goes to the project's
  `Assets/StreamingAssets/AssetBundles/standalonelinux64/`, so Linux
  client builds also carry the bundles locally.
- `windows64` isn't built. It ships prebuilt in the client repo, and
  Windows build support isn't installed here.

`import --from <…/StreamingAssets/AssetBundles> [--to <dir>]`
- For each of `windows64` and `standalonelinux64` present under
  `--from`, replaces `<to>/AssetBundles/<platform>/` with a copy of every
  `hd/**/*.unity3d`, skipping `.meta`. Files removed upstream disappear.
- `--to` defaults to `web-api/data/mix/cpipe`.
- Prints a per-area summary for each platform (`hd/stickers`, `hd/gags`,
  `hd/gogs`, `hd/avatar_thumbs`, `hd/avatar_multiplane`, other): files
  present vs. paths listed in manifest `00134` under `iphone`. This
  regenerates the MIX_API §10 table.
- Warns if `<to>/donotcopy/n7c4c656` is missing (see Error handling).

## Data flow

1. **Setup (once per deployment, again when content changes):**
   `bun tools/mix-content.ts build --project ~/src/DisneyMix`, then
   `bun tools/mix-content.ts import --from
   ~/src/DisneyMix/Assets/StreamingAssets/AssetBundles`, then restart
   web-api.
2. **Boot:** the app requests `/cpipe` and gets the manifest with
   `cdnRoot = <origin>/cpipe/files` and entries for its platform. The
   manifest is cached for next boot.
3. **Catalog:** `contentdata.joe` loads from StreamingAssets. Stickers
   and gags with no available bundle are dropped. Empty packs are
   dropped.
4. **Display:** a sticker's path
   `AssetBundles/<platform>/hd/stickers/…` translates to
   `<origin>/cpipe/files/<v>/AssetBundles/<platform>/hd/stickers/…`.
   It's served from disk and cached by Unity under version `v`.
5. **Messaging:** unchanged. The sender's `ContentId` is relayed, and the
   receiver resolves it through the same catalog and manifest.

## Error handling

| Failure | Behaviour |
|---|---|
| `/cpipe` unreachable, error status, empty body | Client falls back to the bundled or cached manifest. Panels show only bundles in StreamingAssets. |
| `/cpipe` returns malformed JSON | `Prepare` already deletes the cached manifest. The loader then falls back as above instead of failing boot. |
| Bundle listed but download fails | The client's existing per-item warning icon. Rare, because the manifest is built from files on disk. |
| Content tree missing on the server | `scanContent` logs one line. `/cpipe` serves the base manifest, which is today's behaviour. |
| Config refetch | Once the client fetches `/cpipe`, the boot-config refetch (MIX_API §2) goes live: every server restart advertises a newer `donotcopy/n7c4c656`, which must exist in `data/mix/cpipe/`. `import` warns when it's missing. |
| Stale Unity cache after re-import | `v` = mtime changes, so the client refetches. |

## Testing

**Server: `tools/mix-content-test.ts`** (new, same style as the other
`tools/*-test.ts`, run with
`for t in tools/*-test.ts; do bun "$t" || break; done`)
- `scanContent` on a temp tree: one entry per file, keyed with forward
  slashes, correct CRC (checked against a known value) and `v`, `.meta`
  files excluded, missing root → no entries.
- `GET /cpipe` with content: entries for present files only, base
  `android`/`iphone` entries unchanged, `cdnRoot` as before. Without
  content: the base manifest.
- `GET /cpipe/files/<v>/AssetBundles/windows64/hd/…` returns the file's
  bytes. A traversal attempt returns 404.
- `import` into a temp `--to`: copies `.unity3d`, skips `.meta`, removes
  a stale file, reports correct counts, warns when the config is
  missing.

**Client: live check on the native Linux build** (`~/src/DisneyMix-build`)
1. web-api logs `GET /cpipe`, then `/cpipe/files/…/standalonelinux64/…`
   requests.
2. Sticker and gag panels show only available packs and items, with no
   warning icons.
3. A sticker sent to a second account renders on both sides. A gag plays
   on its target.
4. With web-api stopped, the app still boots (bundled fallback).
5. The temporary `StreamingAssets\contentdata.joe` symlink is removed,
   and the catalog still loads.

**Windows:** not testable here. Coverage is code review, the imported
`windows64` files being byte-identical to the client repo's, and a
request for a Windows test in the OpenCPIsland PR. This limit is stated
in the PR.

**Docs:** MIX_API §2 (cpipe) and §10 are updated as each part lands. The
§10 table is regenerated from the `import` summary.

## Open questions

- Whether `RebuildAssetBundles.RebuildAll` runs cleanly under
  `-batchmode` (decides client item 5).
- How long a full Linux bundle rebuild takes (affects the setup
  instructions, not the design).
