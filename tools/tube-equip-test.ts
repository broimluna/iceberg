// The equipped snow tube survives room changes: the client takes its tube
// from JoinRoomData.selectedTubeId on every join, so PUT /tube/v1/equip/:type
// must be stored and handed back there. Unknown tube ids are refused.
import { startWebApi, makeChecker } from "./lib/harness.ts";

const { check, finish } = makeChecker();
const api = await startWebApi({ env: { ALLOW_SWID_AUTH: "1" } });
const BASE = api.base;

try {
  const auth = { Authorization: "Basic " + btoa("{TUBETEST-1}:x") };
  const other = { Authorization: "Basic " + btoa("{BEEFCAFE-2}:x") };
  await fetch(`${BASE}/player/v1`, { headers: auth });
  await fetch(`${BASE}/player/v1`, { headers: other });

  const join = async (h: Record<string, string>) => {
    const r = await fetch(`${BASE}/game/v1/worlds/Alpine/language/en_US/rooms/Town/players`, { method: "POST", headers: { ...h, "Content-Type": "application/json" }, body: "{}" });
    return ((await r.json()) as any).data;
  };
  const equip = (id: string, h = auth) =>
    fetch(`${BASE}/tube/v1/equip/${id}`, { method: "PUT", headers: { ...h, "Content-Type": "application/json" }, body: "{}" });

  check((await join(auth))?.selectedTubeId === 0, "a new player joins with the default tube 0");

  const r = await equip("3");
  const body = (await r.json()) as any;
  check(r.ok && body?.data?.tubeId === 3, `equip tube 3 -> ${r.status} ${JSON.stringify(body?.data)}`);
  const joined = await join(auth);
  check(joined?.selectedTubeId === 3, `the next join carries the equipped tube (${joined?.selectedTubeId})`);
  check(typeof joined?.selectedTubeId === "number", "selectedTubeId is a number (client field is int)");
  check((await join(other))?.selectedTubeId === 0, "another player's tube is unaffected");

  // Unknown ids are refused and leave the stored tube alone.
  for (const bad of ["9999", "-1", "abc", "2.5", "4294967299"]) {
    const res = await equip(bad);
    check(res.status === 400, `equip ${bad} -> 400 (${res.status})`);
  }
  check((await join(auth))?.selectedTubeId === 3, "a refused equip keeps the previous tube");

  // Back to the default tube.
  check((await equip("0")).ok, "equip tube 0");
  check((await join(auth))?.selectedTubeId === 0, "tube 0 is stored too");
} finally {
  api.stop();
}
finish();
