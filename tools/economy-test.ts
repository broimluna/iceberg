// The economy is server-side: requests can't name their own rewards,
// counts and prices can't go negative, purchases need the coins, quests
// pay only for defined quests and objectives, room collectibles pay once
// per respawn, and one player can't overwrite another's items.
import { Database } from "bun:sqlite";
import { startWebApi, makeChecker } from "./lib/harness.ts";
import { createPlayer } from "./lib/mix-client.ts";

const { check, finish } = makeChecker();
const api = await startWebApi({ env: { ALLOW_SWID_AUTH: "1" } });
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
} finally {
  await api.stop();
}
finish();
