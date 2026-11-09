// smartfox-server/data/world-objects.json: Disney's ScheduledWorldObjects and
// IslandTargets server data (extracted from the CDN, checked against the
// scenes). Counts, rewards, path nesting and the scale-corrected radii.
import { makeChecker } from "./lib/harness.ts";
import data from "../smartfox-server/data/world-objects.json" with { type: "json" };

const { check, finish } = makeChecker();
const d = data as any;
const near = (a: number, b: number, eps = 0.001) => Math.abs(a - b) < eps;
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

// ---- scheduled world objects ----
const swo = d.scheduledWorldObjects;
check(same(Object.keys(swo), ["Boardwalk"]), `only Boardwalk has scheduled objects (${Object.keys(swo)})`);
const geysers = swo.Boardwalk?.[0];
check(swo.Boardwalk?.length === 1 && geysers?.path === "/Minigames/AquaFunHut/GeyserLocations", "one Boardwalk geyser group");
check(geysers?.behaviour === "nonRepeatingRandom" && geysers?.cycleSeconds === 17, `geysers: nonRepeatingRandom every 17 s (${geysers?.behaviour}, ${geysers?.cycleSeconds})`);
check(geysers?.children?.length === 8, `8 geysers (${geysers?.children?.length})`);
const g1 = geysers?.children?.find((c: any) => c.path.endsWith("/GeyserLocation01"));
check(same(g1?.position, [8.4, -1.54, 24.24]), `GeyserLocation01 position (${JSON.stringify(g1?.position)})`);

// ---- island targets ----
const it = d.islandTargets;
check(same(Object.keys(it), ["MtBlizzard"]), `only MtBlizzard has island targets (${Object.keys(it)})`);
const pg = it.MtBlizzard?.[0];
check(it.MtBlizzard?.length === 1 && pg?.path === "/Minigames/ClockTower/TargetsPlayground", "one Mt Blizzard playground");
check(pg?.everyXMinutes === 5 && pg?.behaviour === "nonRepeatingRandom", `every 5 minutes, nonRepeatingRandom (${pg?.everyXMinutes}, ${pg?.behaviour})`);
check(same(pg?.rewardsVolume, { center: [-3.65, -0.99, -4.41], radius: 12.4 }), `reward zone (${JSON.stringify(pg?.rewardsVolume)})`);

const supersets: any[] = pg?.supersets ?? [];
const phases = supersets.flatMap((s) => s.phases);
const targets = phases.flatMap((p: any) => p.targets);
check(supersets.length === 7 && phases.length === 29 && targets.length === 106, `7 supersets, 29 phases, 106 targets (${supersets.length}, ${phases.length}, ${targets.length})`);
check(supersets.every((s) => same(s.totalReward, { coins: 100, mascotXP: { AuntArctic: 40 } })), "every superset pays 100 coins + 40 Aunt Arctic XP in total");
check(supersets.every((s) => same(s.minPerPlayerReward, { coins: 20, mascotXP: { AuntArctic: 10 } })), "every superset's minimum per player is 20 coins + 10 XP");
check(supersets.every((s) => s.path.startsWith(pg.path + "/") && s.phases.every((p: any) => p.path.startsWith(s.path + "/"))), "phase paths sit under their superset");
check(phases.every((p: any) => p.sessionSeconds > 0 && p.targets.length > 0 && p.targets.every((t: any) => t.path.startsWith(p.path + "/"))), "target paths sit under their phase");
check(targets.every((t: any) => t.hitSphere.radius > 0 && t.hitSphere.radius >= t.hitSphere.rawRadius), "radii positive and not below Disney's raw value");
check(targets.every((t: any) => t.minHits > 0 && t.populationMultiplier >= 0 && t.position.length === 3 && t.hitSphere.center.length === 3), "targets have hits, multiplier and vectors");
const finals = supersets.map((s) => s.phases.at(-1).targets);
check(finals.every((f) => f.length === 1 && f[0].minHits === 40 && near(f[0].hitSphere.radius, 0.715)), `each superset ends on one 40-hit target, radius 0.715 (${finals.map((f) => `${f.length}:${f[0]?.minHits}:${f[0]?.hitSphere?.radius}`)})`);

// ---- hygiene ----
const text = JSON.stringify(d);
check(!text.includes("activeDates"), "no date-windowed entries ship yet");
check(!/\/home\/|\/run\/media|iceberg-private/.test(text), "no local paths leak into the data");
check(/^\d+\/ServerData\/[0-9a-f]+\.json$/.test(d.sources?.islandTargets) && /^\d+\/ServerData\/[0-9a-f]+\.json$/.test(d.sources?.scheduledWorldObjects), `sources are CDN-relative (${JSON.stringify(d.sources)})`);

finish("");
