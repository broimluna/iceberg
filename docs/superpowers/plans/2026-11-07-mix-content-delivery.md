# Mix Content Delivery (Stickers and Gags) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stickers and gags show and work in Disney Mix source builds (native Linux and Windows), served by iceberg.

**Architecture:** iceberg scans a git-ignored bundle tree at startup and merges an entry per file into its `/cpipe` manifest. A bun tool builds the Linux bundles with Unity and imports both platforms into that tree. The client (OpenCPIsland/DisneyMix) refreshes the manifest from the network again, asks for its real desktop platform folder, fixes a Linux path bug, and skips stickers and gags it can't get.

**Tech Stack:** bun + express (web-api), bun scripts (`tools/`), Unity 6000.3.14f1 C# (client, IL2CPP).

**Spec:** `docs/superpowers/specs/2026-11-07-mix-content-delivery-design.md` (read it with this plan, especially the client items 1 and 4 amendments).

## Global Constraints

- Repos: iceberg `~/Desktop/cpi-private-server-release` (branch `mix-content-delivery` off `main`); client `~/src/DisneyMix` (branch `iceberg/content-delivery` off `main`).
- Client: commit only files a task names. `Assets/StreamingAssets/donotcopy/n7c4c656` (modified) and `Assets/Resources/json/assetbundles.json.meta` (deleted) are pre-existing local changes. Never stage them.
- Platforms served: `windows64` and `standalonelinux64` only. Android/iphone manifest entries stay untouched.
- Manifest entry: key `AssetBundles/<platform>/<rest>` (forward slashes), `crc` = CRC32 as 8 uppercase hex digits, `v` = file mtime in whole Unix seconds.
- `web-api/data/mix/cpipe/AssetBundles/` is git-ignored. Bundles are never committed to iceberg.
- Unity editor: `~/Unity/Hub/Editor/6000.3.14f1/Editor/Unity`. Exit code 198 = license missing (copy `~/.var/app/com.unity.UnityHub/config/unity3d/Unity/licenses/UnityEntitlementLicense.xml` to `~/.config/unity3d/Unity/licenses/`).
- Don't `pkill -f` a pattern that appears in your own command line.
- iceberg tests: `for t in tools/*-test.ts; do bun "$t" || break; done`. Every task leaves all suites green.
- Keep `docs/MIX_API.md` current in the task that makes a change: mark facts inferred where they are, and say why.
- Don't push either repo, and don't open the upstream PR. The user decides both at the end.

**Client compile check** (used by Tasks 4-6): with the Mix app closed, run
`~/Unity/Hub/Editor/6000.3.14f1/Editor/Unity -batchmode -quit -nographics -projectPath ~/src/DisneyMix -logFile ~/src/DisneyMix-compile.log; echo exit=$?`
It passes when exit is 0 and `grep -c "error CS" ~/src/DisneyMix-compile.log` prints 0.

## Review Focus

1. **The startup sequence stalls on the config refetch.** Once the client really fetches `/cpipe`, `CpipeUpdateOperation` waits for `OnExternalizedConstantsRefreshed` whenever the config's `v` is newer, and iceberg advertises a newer one on every restart. Expected: boot completes. Pinned by the Task 7 live check, step 2. If it stalls, stop and report: that's a design question, not something to patch around.
2. **Bundles shipped locally hide the server path.** Linux builds carry `standalonelinux64` bundles in StreamingAssets, so the client never downloads them. Expected: server delivery is proven anyway. Task 7 moves the build's local folder aside for one run.
3. **A trailing slash or backslash in file keys.** Expected: manifest keys always use `/`, and a `.meta` file never appears. Pinned in the Task 1 test.
4. **Re-importing removes content.** Expected: a bundle deleted upstream disappears from the tree and from the manifest after a restart. Pinned in the Task 2 test (stale file removed).
5. **Content tree absent on a fresh deployment.** Expected: `/cpipe` returns today's manifest unchanged, with one log line. Pinned in the Task 1 test.

---

### Task 1: iceberg serves bundle entries in `/cpipe`

**Files:**
- Create: `web-api/src/services/mixContent.ts`
- Modify: `web-api/src/routes/cpipe.ts`
- Modify: `tools/lib/harness.ts:32` (copy `data/` without `data/mix/cpipe/AssetBundles`)
- Modify: `.gitignore:22-23`
- Create: `tools/mix-content-test.ts`
- Modify: `tools/README.md`, `docs/MIX_API.md` §2 "In iceberg"

**Interfaces:**
- Produces: `export const CONTENT_PLATFORMS = ["windows64", "standalonelinux64"] as const;`
  `export type ManifestEntry = { crc: string; v: number };`
  `export function scanContent(root: string): Record<string, ManifestEntry>`. `root` is the cpipe files root (the dir holding `AssetBundles/`). It returns `{}` and logs one `[CPIPE]` line when `root/AssetBundles` is missing or unreadable.

- [ ] **Step 1: Branch.** `git -C ~/Desktop/cpi-private-server-release switch -c mix-content-delivery`

- [ ] **Step 2: Write the failing test** `tools/mix-content-test.ts`, same style as `tools/mix-boot-test.ts` (`startWebApi`, `makeChecker`, `check`, `finish`):
  - Unit, on a temp dir from `mkdtempSync`:
    - `scanContent(missingDir)` deep-equals `{}`.
    - Create `AssetBundles/windows64/hd/stickers/a/a_hd.unity3d` containing `hello`, its `.meta`, `AssetBundles/standalonelinux64/hd/gags/g/g_hd.unity3d`, and `AssetBundles/android/hd/x.unity3d`. Set the windows file's mtime with `utimesSync(f, 1700000000, 1700000000)`.
    - Check: keys are exactly `AssetBundles/windows64/hd/stickers/a/a_hd.unity3d` and `AssetBundles/standalonelinux64/hd/gags/g/g_hd.unity3d` (no `.meta`, no android, no backslashes). The windows entry deep-equals `{ crc: "3610A686", v: 1700000000 }`.
  - Server: `startWebApi({ beforeStart })`. `beforeStart` gets `dbPath`, and the copy's root is `dirname(dirname(dbPath))`, so the fake tree goes in that root's `data/mix/cpipe/`. Write the same windows file there before start. Check:
    - `GET /cpipe` (with an `Authorization` header) has `manifest.paths["AssetBundles/windows64/hd/stickers/a/a_hd.unity3d"]` = `{crc: "3610A686", v: 1700000000}`.
    - An `AssetBundles/iphone/...` key from the base manifest still has the same value as in `web-api/data/mix/cpipe-manifest.json`.
    - `manifest.cdnRoot === \`${api.base}/cpipe/files\``.
    - `GET /cpipe/files/1700000000/AssetBundles/windows64/hd/stickers/a/a_hd.unity3d` returns body `hello`.
  - Server without a tree: a second `startWebApi()`. Its `/cpipe` paths count equals the base manifest's `paths` count.

- [ ] **Step 3: Run it to see it fail.** `bun tools/mix-content-test.ts`. Expected: it fails to import `scanContent`, or the manifest entry checks FAIL.

- [ ] **Step 4: Implement `scanContent` in `web-api/src/services/mixContent.ts`.** Recursive walk with `readdirSync(..., { withFileTypes: true })`. Skip names ending `.meta`. `crc` = `Bun.hash.crc32(bytes).toString(16).toUpperCase().padStart(8, "0")`. `v` = `Math.floor(statSync(f).mtimeMs / 1000)`. Build keys with `/` joins, not `path.join`.

- [ ] **Step 5: Use it in `routes/cpipe.ts`.** At module load: `const CONTENT = scanContent(FILES_ROOT);` and log the entry count. In `GET /cpipe`, assign `CONTENT` into the cloned `manifest.paths` *before* the config-version line. Update the file's header comment.

- [ ] **Step 6: Harness and ignore.** `harness.ts`: give the `data` `cpSync` a filter that excludes paths containing `/data/mix/cpipe/AssetBundles`. That's about 136 MB that every suite would otherwise copy. `.gitignore`: add `web-api/data/mix/cpipe/AssetBundles/` under the existing Mix comment, with a line saying the bundles are filled by `bun tools/mix-content.ts import`.

- [ ] **Step 7: Run it to see it pass, then the full suite.** `bun tools/mix-content-test.ts` → all PASS. Then the full loop → all ok.

- [ ] **Step 8: Docs.** MIX_API §2 "In iceberg": `/cpipe` merges entries for files under `data/mix/cpipe/AssetBundles/{windows64,standalonelinux64}/`, scanned at startup, with crc/v as above. Explain why `v` = mtime (it's the client's Unity cache version) and that new files need a restart. `tools/README.md`: add a row for `mix-content-test.ts`.

- [ ] **Step 9: Commit.** `git add web-api/src/services/mixContent.ts web-api/src/routes/cpipe.ts tools/lib/harness.ts .gitignore tools/mix-content-test.ts tools/README.md docs/MIX_API.md && git commit -m "feat(cpipe): serve Mix bundle entries for windows64 and standalonelinux64"`

---

### Task 2: `tools/mix-content.ts import`

**Files:**
- Create: `tools/mix-content.ts`
- Modify: `tools/mix-content-test.ts`, `tools/README.md`, `docs/MIX_API.md` §10

**Interfaces:**
- Consumes: `CONTENT_PLATFORMS` from `web-api/src/services/mixContent.ts`.
- Produces: CLI `bun tools/mix-content.ts import --from <dir> [--to <dir>]`. `--to` defaults to `web-api/data/mix/cpipe` (resolved from the script's dir). Exit 0 on success, 1 with a usage message on bad args or a missing `--from`.

- [ ] **Step 1: Write the failing tests** (append to `tools/mix-content-test.ts`). Build a temp `from` with `windows64/hd/stickers/s1/s1_hd.unity3d`, its `.meta`, and `windows64/hd/gags/g1/g1_hd.unity3d`. Build a temp `to` already holding `AssetBundles/windows64/hd/stickers/old/old_hd.unity3d` and no `donotcopy/`. Run `$\`bun tools/mix-content.ts import --from ${from} --to ${to}\`.nothrow().quiet()` and check:
  - exit 0
  - the two `.unity3d` files exist under `to/AssetBundles/windows64/hd/…`
  - no `.meta` was copied
  - `old_hd.unity3d` is gone
  - stdout matches `/hd\/stickers\s+1 present \/ \d+ listed/`
  - stdout or stderr contains `donotcopy/n7c4c656`, the missing-config warning
  - `import` without `--from` exits 1

- [ ] **Step 2: Run them to see them fail.** `bun tools/mix-content.ts` doesn't exist yet → FAIL.

- [ ] **Step 3: Implement `import`.** For each platform in `CONTENT_PLATFORMS` with a `from/<platform>/` dir:
  - `rmSync(to/AssetBundles/<platform>, { recursive: true, force: true })`
  - copy every `hd/**/*.unity3d`
  - print one line per area: `hd/stickers`, `hd/gags`, `hd/gogs`, `hd/avatar_thumbs`, `hd/avatar_multiplane`, `other`. Format: `<area padded> <present> present / <listed> listed`. `listed` counts `web-api/data/mix/cpipe-manifest.json` paths under `AssetBundles/iphone/<area>/`. `other` covers the rest of `AssetBundles/iphone/hd/`.

  Then warn on stderr if `to/donotcopy/n7c4c656` is missing. Say that the client refetches it whenever the server restarts (MIX_API §2), and give the render command `bun tools/mix-config.ts render <url> --out <to>/donotcopy/n7c4c656`. Follow `tools/mix-config.ts` for arg parsing and the usage text.

- [ ] **Step 4: Run them to see them pass.** `bun tools/mix-content-test.ts` → PASS.

- [ ] **Step 5: Import the real Windows bundles.** `bun tools/mix-content.ts import --from ~/src/DisneyMix/Assets/StreamingAssets/AssetBundles`. Expected: the `windows64` summary shows 142 stickers present and 28 gags present (the counts in MIX_API §10). `git status` shows no `AssetBundles` files, because they're ignored.

- [ ] **Step 6: Docs and commit.** MIX_API §10 "What it would take": point to the tool. `tools/README.md`: add a usage line. Then `git add tools/mix-content.ts tools/mix-content-test.ts tools/README.md docs/MIX_API.md && git commit -m "feat(tools): mix-content import of rebuilt Mix bundles"`

---

### Task 3: `tools/mix-content.ts build` (Linux bundles)

**Files:**
- Modify: `tools/mix-content.ts`, `tools/mix-content-test.ts`, `docs/MIX_API.md` §5 "Building the Mix app from source"
- Maybe client: `~/src/DisneyMix/Assets/Editor/RebuildAssetBundles.cs` (spec client item 5, only if Step 5 shows it's needed)

**Interfaces:**
- Produces: CLI `bun tools/mix-content.ts build --project <path> [--unity <editor>] [--method <Class.Method>]`. `--method` defaults to `RebuildAssetBundles.RebuildAll`. Exit codes: 0 ok; 2 Unity exited 198 (license message); 1 any other failure (prints the log path).

- [ ] **Step 1: Write the failing tests.** A fake editor: a temp shell script that writes `"$@"` to `args.txt` and exits with `$FAKE_EXIT`. Check:
  - `FAKE_EXIT=0` → exit 0, and `args.txt` contains `-batchmode`, `-quit`, `-nographics`, `-projectPath <project>`, `-buildTarget Linux64`, `-executeMethod RebuildAssetBundles.RebuildAll` and `-logFile`.
  - `FAKE_EXIT=198` → exit 2, and the output mentions `UnityEntitlementLicense.xml`.
  - `FAKE_EXIT=1` → exit 1, and the output contains the log path.

- [ ] **Step 2: Run them to see them fail.**

- [ ] **Step 3: Implement `build`.** Use `Bun.spawn` with stdio inherited. The log goes to `<project>-bundles.log`. The editor defaults to the path in Global Constraints.

- [ ] **Step 4: Run them to see them pass.**

- [ ] **Step 5: Run the real build.** With the Mix app closed: `bun tools/mix-content.ts build --project ~/src/DisneyMix`. Expected: exit 0, and `~/src/DisneyMix/Assets/StreamingAssets/AssetBundles/standalonelinux64/hd/stickers/` exists with as many `.unity3d` files as `windows64/hd/stickers/`.
  - If the editor hangs, opens a dialog, or exits 0 without output: add `public static void RebuildAllBatch()` to `RebuildAssetBundles.cs`. It calls `RebuildAll()` inside try/catch and calls `EditorApplication.Exit(1)` on an exception or when the output folder is empty. Rerun with `--method RebuildAssetBundles.RebuildAllBatch`, make it the default `--method`, and commit it in the client repo on `iceberg/content-delivery` (create the branch first: `git -C ~/src/DisneyMix switch -c iceberg/content-delivery`).

- [ ] **Step 6: Import Linux too.** `bun tools/mix-content.ts import --from ~/src/DisneyMix/Assets/StreamingAssets/AssetBundles`. Expected: summaries for both platforms.

- [ ] **Step 7: Docs and commit.** MIX_API: the build command, the time it took, and the bundle count. Note that Windows bundles aren't rebuilt here (no Windows build support), and whether the batch wrapper was needed and why. `git add tools/mix-content.ts tools/mix-content-test.ts docs/MIX_API.md && git commit -m "feat(tools): mix-content build of standalonelinux64 bundles"`

---

### Task 4: Client paths: catalog path and bundle platform

**Files** (client, under `Assets/Scripts/Assembly-CSharp/`):
- Modify: `Mix/Data/ContentData.cs:71`
- Modify: `Mix/Assets/AssetManager.cs:608-645` (platform constant), `:1032-1042` (`GetCpipePrefix`)
- Modify: `Mix/SettingsManager.cs:109-112`
- Modify: `Mix/Assets/BackgroundLoader.cs:50`

**Interfaces:**
- Produces: `public const string BundlePlatform` in `AssetManager`: `"android"`, `"iphone"`, `"windows64"`, `"standalonemacos"` or `"standalonelinux64"`, chosen by the existing `#if` chain. `BundleFolder` becomes `"AssetBundles/" + BundlePlatform + "/"`. Also produces `public string SettingsManager.GetBundlePlatform()`, which returns `AssetManager.BundlePlatform`.

- [ ] **Step 1: Branch** (skip if Task 3 created it): `git -C ~/src/DisneyMix switch -c iceberg/content-delivery`

- [ ] **Step 2: Fix the catalog path.** `ParseJoeData(Path.Combine(Application.StreamingAssetsPath, "contentdata.joe"))`. Remove the `+ "\\"` assignment, and keep the empty check on the incoming argument. Add `using System.IO;` if it's missing.

- [ ] **Step 3: Platform constant.** In the `#if` chain, replace each `BundleFolder` constant with a `BundlePlatform` constant. Linux becomes `standalonelinux64`, the folder `RebuildAssetBundles` writes for `StandaloneLinux64`. Define `BundleFolder` from it after the chain. Keep the chain's order and conditions otherwise unchanged.

- [ ] **Step 4: Use it.** Add `GetBundlePlatform()` to `SettingsManager`. `GetCpipePrefix` and `BackgroundLoader` call it instead of `GetDeviceString()`. Leave `GetDeviceString()` unchanged.

- [ ] **Step 5: Compile check** (Global Constraints). Expected: exit 0, 0 `error CS`.

- [ ] **Step 6: Commit.** `git -C ~/src/DisneyMix add Assets/Scripts/Assembly-CSharp/Mix/Data/ContentData.cs Assets/Scripts/Assembly-CSharp/Mix/Assets/AssetManager.cs Assets/Scripts/Assembly-CSharp/Mix/SettingsManager.cs Assets/Scripts/Assembly-CSharp/Mix/Assets/BackgroundLoader.cs && git -C ~/src/DisneyMix commit -m "Fix desktop content paths: catalog path on Linux/macOS, real platform folder for asset bundles"`

---

### Task 5: Client: refresh the manifest from the network

**Files:**
- Modify: `Assets/Scripts/Assembly-CSharp/Mix/CpipeFileManifestLoader.cs`

**Interfaces:**
- Consumes: `Singleton<CpipeManifestApi>.Instance.GetCpipeManifest(string aEnvironment, string aClientVersionNumber, string aManifestVersionNumber, ITextAssetObject aCallingObject, CachePolicy aCachePolicy, bool getLatest = false, object aUserData = null)`.

- [ ] **Step 1: `Load()`.**
  - `aIsFirstRun` true: `PrepareManifest(null, true)`, as today.
  - Otherwise: `GetCpipeManifest(string.Empty, EnvironmentManager.BundleVersion.ToString(), oldVersion, this, aCachePolicy)`. `aEnvironment` is unused by the request.
  - Replace the "CPIPE backend retired" comment with one explaining the two loads and why the first can't use the network (`cpipe` is null until the first load completes; `AssetManager.GetCpipeUrl`).

- [ ] **Step 2: Failures keep the current manifest.** In `TextReady`, the final `onError(...)` becomes `onComplete(false)`, keeping the existing `Log.Exception` for 204. Add a private `bool refreshing` set from `!aIsFirstRun`. In `PrepareManifest`, when `!manifest.Prepare(...)` and `refreshing`, call `onComplete(false)`. On the first run it still calls `onError`.

- [ ] **Step 3: Compile check.** Expected: exit 0, 0 `error CS`.

- [ ] **Step 4: Commit.** `git -C ~/src/DisneyMix add Assets/Scripts/Assembly-CSharp/Mix/CpipeFileManifestLoader.cs && git -C ~/src/DisneyMix commit -m "Refresh the cpipe manifest from cpipe_url again, keeping the bundled one on failure"`

---

### Task 6: Client: hide stickers and gags with no bundle

**Files:**
- Modify: `Assets/Scripts/Assembly-CSharp/Mix/Assets/AssetManager.cs` (new method next to `IsBundleCached`)
- Modify: `Assets/Scripts/Assembly-CSharp/Mix/Entitlements/EntitlementsManager.cs` (`RefreshStickerPacks` ~363, `RefreshStickers` ~433, `RefreshGags` ~504)

**Interfaces:**
- Produces: `public bool AssetManager.IsBundleAvailable(string entitlementPath)`. It returns false for null or empty. Otherwise it computes `prefix = GetCpipePrefix(entitlementPath)` and returns true when `cpipeManager?.cpipe != null && !string.IsNullOrEmpty(cpipeManager.cpipe.GetFileUrl(prefix))`, or when `File.Exists(Path.Combine(Application.StreamingAssetsPath, prefix))`.

- [ ] **Step 1: Add `IsBundleAvailable`.**

- [ ] **Step 2: Filter.**
  - `RefreshStickers` and `RefreshGags` pass only items with `MonoSingleton<AssetManager>.Instance.IsBundleAvailable(item.GetHd())` to `SetVisibleAndOwnedContent`.
  - `RefreshStickerPacks` first calls `RefreshStickers()`, then passes only packs where at least one id in `GetStickers()` resolves to a sticker in `AllStickers` (match `GetUid()`).
  - Don't change `SetVisibleAndOwnedContent` (games and avatar parts must stay unfiltered).

- [ ] **Step 3: Compile check.** Expected: exit 0, 0 `error CS`.

- [ ] **Step 4: Commit.** `git -C ~/src/DisneyMix add Assets/Scripts/Assembly-CSharp/Mix/Assets/AssetManager.cs Assets/Scripts/Assembly-CSharp/Mix/Entitlements/EntitlementsManager.cs && git -C ~/src/DisneyMix commit -m "Hide stickers, gags and sticker packs whose bundles are unavailable"`

---

### Task 7: Live check, docs and upstream patches

**Files:**
- Modify: `docs/MIX_API.md` §2 and §10 (iceberg)
- Create: `~/src/DisneyMix-patches/` (format-patch output and `PR.md`, outside both repos)

- [ ] **Step 1: Build the player.** Remove the temporary symlink. It sits in `DisneyMix_Data/` under the literal name `StreamingAssets\contentdata.joe`, so confirm with `ls ~/src/DisneyMix-build/DisneyMix_Data/` and then run `rm ~/src/DisneyMix-build/DisneyMix_Data/'StreamingAssets\contentdata.joe'`. Then build with the command in memory `mix-client-builds` (`-buildTarget Linux64 -buildLinux64Player ~/src/DisneyMix-build/DisneyMix.x86_64`). Expected: exit 0.

- [ ] **Step 2: Server-delivery run.** Move the build's local Linux bundles aside: `mv ~/src/DisneyMix-build/DisneyMix_Data/StreamingAssets/AssetBundles/standalonelinux64 ~/src/DisneyMix-build/standalonelinux64.aside`. Clear the app's cached manifest: delete `~/.config/unity3d/*/*/cache/` after checking the path with `ls`. Start web-api and smartfox-server, then launch `~/src/DisneyMix-build/DisneyMix.x86_64`. Log in as one account, with a 1:1 chat open to a second account. The second account is driven by the SDK client in `tools/lib/mix-client.ts`, through a short throwaway script in the scratchpad. It sends a sticker and a gag with real `ContentId`s from the catalog (`PUT /chatThread/stickerMessage` and `/gagMessage`) and reads back what the app sends. Check, and record each in the task report:
  1. web-api logs `GET /cpipe?restrict=true&cv=…`.
  2. Boot completes, with no stall on the config refetch (Review Focus 1). If it stalls, stop and report.
  3. After opening the sticker panel, web-api logs `/cpipe/files/<v>/AssetBundles/standalonelinux64/hd/stickers/…` requests.
  4. Only available packs and items show, with no warning icons.
  5. A sticker and a gag from the second account render or play in the app. A sticker sent from the app arrives at the second account with its `ContentId`, and it renders in the app's own history.
  6. The catalog loads with the symlink gone.

- [ ] **Step 3: Offline run.** Move `standalonelinux64.aside` back. Stop web-api and launch again. Expected: the app boots, and the panels show the local bundles.

- [ ] **Step 4: Docs.**
  - MIX_API §10: rewrite "Content delivery in source builds" as fixed, describing what changed in the client and why.
  - Regenerate the present/missing table from the `import` summary.
  - Add to §2 that the client now refreshes the manifest, and the order of the two loads.

  Commit in iceberg: `git add docs/MIX_API.md && git commit -m "docs(mix): content delivery works in source builds"`. Run the full iceberg suite first, and it must be all ok.

- [ ] **Step 5: Upstream patches.** `git -C ~/src/DisneyMix format-patch main..iceberg/content-delivery -o ~/src/DisneyMix-patches`. Write `~/src/DisneyMix-patches/PR.md` for OpenCPIsland maintainers. It covers:
  - what was broken on Linux/macOS and why
  - each commit's change
  - that the manifest refresh needs a server answering `cpipe_url` (iceberg does), and that without one the app behaves as before
  - that Windows was not run and needs a tester

  Don't push or open the PR.

- [ ] **Step 6: Report.** Give the user the iceberg branch and the client branch, the live-check results, and the patch folder. Ask whether to merge and push iceberg, and how they want to submit the upstream PR.
