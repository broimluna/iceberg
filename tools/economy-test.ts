// The economy is server-side: requests can't name their own rewards,
// counts and prices can't go negative, purchases need the coins, quests
// pay only for defined quests and objectives, room collectibles pay once
// per respawn, and one player can't overwrite another's items.
import { Database } from "bun:sqlite";
import { startWebApi, makeChecker } from "./lib/harness.ts";
import { createPlayer } from "./lib/mix-client.ts";

const { check, finish } = makeChecker();
const api = await startWebApi({ env: { ALLOW_SWID_AUTH: "1", FISHING_MIN_CATCH_MS: "1000", FISHING_MIN_CAST_MS: "1000" } });
const sql = (q: string, ...p: any[]) => { const d = new Database(api.dbPath); try { return d.query(q).all(...p) as any[]; } finally { d.close(); } };

let n = 0;
async function player() {
  const swid = `{econ-${n++}}`;
  await createPlayer(api.base, api.dbPath, swid, `Econ${n}x`);
  const username = sql("SELECT username FROM player_identity WHERE swid = ?", swid)[0].username as string;
  const auth = { Authorization: "Basic " + btoa(`${swid}:x`) };
  const call = async (method: string, path: string, body?: unknown, type = "application/json") => {
    const r = await fetch(`${api.base}${path}`, {
      method, headers: { ...auth, "Content-Type": type },
      body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
    });
    let json: any = null;
    try { json = await r.json(); } catch {}
    return { status: r.status, json };
  };
  const coins = () => sql("SELECT coins FROM player_assets WHERE username = ?", username)[0]?.coins as number;
  const setCoins = (c: number) => sql("UPDATE player_assets SET coins = ? WHERE username = ?", c, username);
  return { swid, username, call, coins, setCoins };
}

try {
  // ---- 1. a request can't name its own reward ----
  {
    const p = await player(); await p.call("GET", "/player/v1/"); const before = p.coins();
    await p.call("POST", "/reward/v1", { coins: 100000, xp: { Rockhopper: 100000 } });
    check(p.coins() === before, `POST /reward/v1 grants nothing (${before} -> ${p.coins()})`);
  }

  // ---- 2 and 3. quests pay only for defined quests and objectives ----
  {
    const p = await player(); await p.call("GET", "/player/v1/"); const before = p.coins();
    for (let i = 0; i < 3; i++) await p.call("POST", `/quest/v1/MadeUpQuest${i}`, "3", "text/plain");
    check(p.coins() === before, `completing made-up quests pays nothing (${before} -> ${p.coins()})`);

    await p.call("POST", "/quest/v1/AAC001Q001LeakyShip", "1", "text/plain");
    await p.call("POST", "/quest/v1/AAC001Q001LeakyShip", "3", "text/plain");
    check(p.coins() === before, `completing a real quest with no objectives done pays nothing (${p.coins()})`);

    const q = await player(); await q.call("GET", "/player/v1/");
    await q.call("POST", "/quest/v1/AAC001Q001LeakyShip", "1", "text/plain");
    const xpBefore = JSON.stringify(sql("SELECT * FROM mascot_xp WHERE username = ?", q.username));
    await q.call("POST", "/quest/v1/progress", { data: ["NotAnObjective1", "NotAnObjective2"] });
    const rows = sql("SELECT objective_id FROM quest_objectives WHERE objective_id LIKE 'NotAnObjective%'");
    check(rows.length === 0, `objectives the quest doesn't define aren't recorded (${rows.length})`);
    check(JSON.stringify(sql("SELECT * FROM mascot_xp WHERE username = ?", q.username)) === xpBefore, "and pay no XP");
    const all = ["Obj0FSM", "Obj2FSM ", "Obj3FSM ", "Obj4FSM", "Obj5FSM", "Obj6FSM", "Obj8FSM", "Obj9FSM", "Obj10FSM", "Obj11FSM"];
    await q.call("POST", "/quest/v1/progress", { data: all });
    const beforeComplete = q.coins();
    const done = await q.call("POST", "/quest/v1/AAC001Q001LeakyShip", "3", "text/plain");
    check(q.coins() === beforeComplete + 50 && done.json?.reward?.coins === 50, `with every objective done, the quest pays its 50 coins (${beforeComplete} -> ${q.coins()})`);
    await q.call("POST", "/quest/v1/AAC001Q001LeakyShip", "1", "text/plain");
    await q.call("POST", "/quest/v1/progress", { data: all });
    await q.call("POST", "/quest/v1/AAC001Q001LeakyShip", "3", "text/plain");
    check(q.coins() === beforeComplete + 50, `a replayed quest doesn't pay again (${q.coins()})`);
  }

  // ---- 4. Coins for Change ----
  {
    const p = await player(); await p.call("GET", "/player/v1/"); p.setCoins(100);
    const neg = await p.call("POST", "/event/v1/cfc/-5000");
    check(neg.status === 400 && p.coins() === 100, `a negative donation is refused (${neg.status}, ${p.coins()})`);
    const over = await p.call("POST", "/event/v1/cfc/500");
    check(over.status === 400 && p.coins() === 100, `donating more than you have is refused (${over.status}, ${p.coins()})`);
    const ok = await p.call("POST", "/event/v1/cfc/40");
    check(ok.status === 200 && p.coins() === 60, `a normal donation works (${ok.status}, ${p.coins()})`);
  }

  // ---- 5. Disney store ----
  {
    const p = await player(); await p.call("GET", "/player/v1/");
    const store = JSON.parse(await Bun.file(`${import.meta.dir}/../web-api/data/DisneyStoreFranchises.json`).text());
    let item: any = null;
    JSON.stringify(store, (_k, v) => { if (!item && v && typeof v === "object" && typeof v.Id === "number" && typeof v.Cost === "number" && v.Cost > 0 && v.Reward) item = v; return v; });
    p.setCoins(item.Cost - 1);
    const neg = await p.call("POST", `/disneystore/v1/purchase/${item.Id}/-100`);
    check(neg.status === 400 && p.coins() === item.Cost - 1, `a negative store count is refused (${neg.status}, ${p.coins()})`);
    const poor = await p.call("POST", `/disneystore/v1/purchase/${item.Id}/1`);
    check(poor.status === 400 && poor.json?.code === 707 && p.coins() === item.Cost - 1, `buying without the coins is refused with 707 (${poor.status})`);
    p.setCoins(item.Cost);
    const ok = await p.call("POST", `/disneystore/v1/purchase/${item.Id}/1`);
    check(ok.status === 200 && p.coins() === 0, `a store purchase with the coins works (${ok.status}, ${p.coins()})`);
  }

  // ---- 6. igloo decorations ----
  {
    const p = await player(); await p.call("GET", "/player/v1/"); p.setCoins(5);
    const neg = await p.call("POST", "/igloo/v1/decorations/0/1?count=-1000");
    check(neg.status === 400 && p.coins() === 5, `a negative decoration count is refused (${neg.status}, ${p.coins()})`);
    const negInc = await p.call("POST", "/igloo/v1/decorations/1/increment/-1000");
    check(negInc.status === 400 && p.coins() === 5, `a negative increment is refused (${negInc.status}, ${p.coins()})`);
    const poor = await p.call("POST", "/igloo/v1/decorations/0/1");
    check(poor.status === 400 && poor.json?.code === 707 && p.coins() === 5, `a decoration without the coins is refused with 707 (${poor.status})`);
    p.setCoins(100);
    const inc = await p.call("POST", "/igloo/v1/decorations/1:0/increment/2");
    check(inc.status === 200 && p.coins() === 40, `two more of decoration 1 cost 2 x 30 (${inc.status}, ${p.coins()})`);
    const unknownDeco = await p.call("POST", "/igloo/v1/decorations/0/999999");
    check(unknownDeco.status === 400 && p.coins() === 40, `an unknown decoration is refused (${unknownDeco.status})`);
  }

  // ---- 7. room collectibles ----
  {
    const p = await player(); await p.call("GET", "/player/v1/"); const before = p.coins();
    const fake: Record<string, number> = {};
    for (let i = 0; i < 50; i++) fake[`/Made/Up/${i}`] = Date.now();
    await p.call("POST", "/reward/v1/room", { data: { room: "Beach", collected: fake } });
    check(p.coins() === before, `made-up collectibles pay nothing (${before} -> ${p.coins()})`);
    const coin = "/Collectibles/Value Groups Container/TEMPORARY_STATIC_COINS/Coin (1)";
    await p.call("POST", "/reward/v1/room", { data: { room: "Beach", collected: { [coin]: Date.now() } } });
    check(p.coins() === before + 1, `a real coin pays once (${p.coins()})`);
    await p.call("POST", "/reward/v1/room", { data: { room: "Beach", collected: { [coin]: Date.now() + 10_000_000 } } });
    check(p.coins() === before + 1, `the same coin again the same day pays nothing, whatever time the client sends (${p.coins()})`);
  }

  // ---- 8. claiming a reward id that doesn't exist ----
  {
    const p = await player(); await p.call("GET", "/player/v1/");
    const r = await p.call("POST", "/reward/v1/claim/99999");
    const owned = sql("SELECT * FROM equipment WHERE username = ? AND definition_id = 99999", p.username);
    check(r.status === 404 && owned.length === 0, `an unknown reward id grants nothing (${r.status}, ${owned.length})`);
  }

  // ---- 9. one player can't overwrite another's item ----
  {
    const a = await player(); const b = await player();
    await a.call("GET", "/player/v1/"); await b.call("GET", "/player/v1/");
    sql("INSERT INTO equipment (equipment_id, username, date_time_created, definition_id, parts_json) VALUES (424242, ?, 1, 7, '[]')", a.username);
    await b.call("POST", "/inventory/v1/equipment", { equipmentId: 424242, definitionId: 1, parts: [{ x: "defaced" }] });
    const row = sql("SELECT * FROM equipment WHERE equipment_id = 424242")[0];
    check(row.username === a.username && row.definition_id === 7 && row.parts_json === "[]", `another player's item is untouched (${JSON.stringify(row)})`);
  }
  // ---- 10. creating clothing pays the template's cost and makes a new item ----
  {
    const p = await player(); await p.call("GET", "/player/v1/"); p.setCoins(39);
    const poor = await p.call("POST", "/inventory/v1/equipment", { definitionId: 1, parts: [] });
    check(poor.status === 400 && poor.json?.code === 707 && p.coins() === 39, `template 1 (40 coins) with 39 coins is refused with 707 (${poor.status})`);
    const unknown = await p.call("POST", "/inventory/v1/equipment", { definitionId: 999999, parts: [] });
    check(unknown.status === 400 && sql("SELECT * FROM equipment WHERE username = ?", p.username).length === 0, `an unknown template is refused (${unknown.status})`);
    const fixed = await p.call("POST", "/inventory/v1/equipment", { definitionId: 2, parts: [] });
    check(fixed.status === 400 && sql("SELECT * FROM equipment WHERE username = ?", p.username).length === 0, `a template the designer can't edit (a reward-only item) is refused (${fixed.status})`);
    p.setCoins(100);
    const ok = await p.call("POST", "/inventory/v1/equipment", { equipmentId: 5555, definitionId: 1, parts: [] });
    check(ok.status === 200 && p.coins() === 60 && ok.json?.equipmentId !== 5555, `creating clothing costs 40 and gets a server id (${ok.status}, ${p.coins()}, ${ok.json?.equipmentId})`);
  }

  // ---- 11 and 12. clothing catalog ----
  {
    const a = await player(); await a.call("GET", "/player/v1/"); const before = a.coins();
    for (let i = 0; i < 3; i++) await a.call("POST", "/catalog/v1/clothing/submit", { scheduledThemeChallengeId: 1, equipment: { definitionId: 77777, parts: [] } });
    for (let i = 2; i < 5; i++) await a.call("POST", "/catalog/v1/clothing/submit", { scheduledThemeChallengeId: i, equipment: { definitionId: 77777, parts: [] } });
    check(a.coins() === before + 100, `only the first submission to the current theme pays its 100 coins (${before} -> ${a.coins()})`);
    check(sql("SELECT * FROM equipment WHERE username = ? AND definition_id = 77777", a.username).length === 0, "and creates no item");
    const items = sql("SELECT * FROM catalog_submissions");
    const b = await player(); await b.call("GET", "/player/v1/"); b.setCoins(0);
    const id = items[0]?.clothing_catalog_item_id ?? items[0]?.clothingCatalogItemId;
    const buy = await b.call("POST", "/catalog/v1/clothing/purchase", { clothingCatalogItemId: id });
    check(buy.status === 400 && buy.json?.code === 707 && b.coins() === 0, `buying from the catalog without the coins is refused (${buy.status}, ${b.coins()})`);
  }

  // ---- 13. the quick-notification reward is daily ----
  {
    const p = await player(); await p.call("GET", "/player/v1/");
    await p.call("POST", "/reward/v1/claimQuickNotification");
    const after1 = p.coins();
    for (let i = 0; i < 3; i++) await p.call("POST", "/reward/v1/claimQuickNotification");
    check(p.coins() === after1, `the quick-notification reward pays once a day (${after1} -> ${p.coins()})`);
  }

  // ---- 14. one daily spin a day ----
  {
    const p = await player(); await p.call("GET", "/player/v1/");
    sql("INSERT OR REPLACE INTO daily_spin_data (username, current_chest_id, num_chests_received, num_punches, time_of_last_spin, num_spins_since_chest) VALUES (?, 0, 0, 0, ?, 0)", p.username, Date.now() - 1000);
    const before = p.coins();
    const again = await p.call("POST", "/reward/v1/claimDailySpin");
    check(again.status === 400 && p.coins() === before, `a second spin the same day is refused (${again.status}, ${before} -> ${p.coins()})`);
    sql("UPDATE daily_spin_data SET time_of_last_spin = ? WHERE username = ?", Date.now() - 86_400_000 * 2, p.username);
    const ok = await p.call("POST", "/reward/v1/claimDailySpin");
    check(ok.status === 200, `a spin on a new day works (${ok.status})`);
  }

  // ---- 15. fishing pays for a prize from your own last cast, once ----
  {
    const p = await player(); await p.call("GET", "/player/v1/"); const before = p.coins();
    await p.call("POST", "/minigame/v1/fishing/catch", { winningRewardName: "coins_large" });
    check(p.coins() === before, `a catch without a cast pays nothing (${before} -> ${p.coins()})`);
    const cast = await p.call("POST", "/minigame/v1/fishing/cast", {});
    const prizes = Object.values(cast.json?.data?.availablePrizeMap ?? {}) as string[];
    await p.call("POST", "/minigame/v1/fishing/catch", { winningRewardName: "not-a-prize" });
    check(p.coins() === before, `a prize that wasn't offered pays nothing (${p.coins()})`);
    await Bun.sleep(1100);
    const cast2 = await p.call("POST", "/minigame/v1/fishing/cast", {});
    const tooFast = await p.call("POST", "/minigame/v1/fishing/catch", { winningRewardName: Object.values(cast2.json?.data?.availablePrizeMap ?? {})[0] });
    check(p.coins() === before, `a catch faster than the minigame can be played pays nothing (${p.coins()})`);
    await Bun.sleep(1100);
    const cast3 = await p.call("POST", "/minigame/v1/fishing/cast", {});
    check(cast3.status === 200, `casting again after the cooldown works (${cast3.status})`);
    await Bun.sleep(1100);
    const offered = Object.values(cast3.json?.data?.availablePrizeMap ?? {}) as string[];
    const won = await p.call("POST", "/minigame/v1/fishing/catch", { winningRewardName: offered[0] });
    const paid = p.coins() - before;
    check(won.status === 200 && paid > 0, `an offered prize pays (${paid}, ${prizes.length} offered)`);
    await p.call("POST", "/minigame/v1/fishing/catch", { winningRewardName: offered[0] });
    check(p.coins() - before === paid, `the same cast can't be caught twice (${p.coins() - before})`);
  }

  // ---- 16. consumables need a real type ----
  {
    const p = await player(); await p.call("GET", "/player/v1/"); p.setCoins(500);
    for (const type of ["__proto__", "constructor", "MadeUpSnack"]) {
      const r = await p.call("POST", `/consumable/v1/${type}/1`);
      check(r.status === 400 && p.coins() === 500, `buying consumable ${type} is refused (${r.status}, ${p.coins()})`);
    }
  }
  // ---- one player can't overwrite another's igloo layout ----
  {
    const a = await player(); const b = await player();
    await a.call("GET", "/player/v1/"); await b.call("GET", "/player/v1/");
    sql("INSERT INTO igloo_layouts (layout_id, username, name, zone_id, lighting_id, music_id, extra_info_json, decorations_layout_json, created_date, last_modified_date, member_only) VALUES (515151, ?, 'Alice Igloo', 'DefaultIgloo', 0, 0, '{}', '[]', 1, 1, 1)", a.username);
    const r = await b.call("PUT", "/igloo/v1/layout/515151", { name: "defaced", decorationsLayout: [] });
    const row = sql("SELECT username, name FROM igloo_layouts WHERE layout_id = 515151")[0];
    check(row.username === a.username && row.name === "Alice Igloo", `another player's igloo layout is untouched (${r.status}, ${JSON.stringify(row)})`);
    const del = await b.call("DELETE", "/igloo/v1/layout/515151");
    check(sql("SELECT * FROM igloo_layouts WHERE layout_id = 515151").length === 1, `and can't be deleted by them (${del.status})`);
  }
} finally {
  await api.stop();
}
finish();
