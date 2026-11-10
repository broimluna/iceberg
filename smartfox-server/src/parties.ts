// The game server's copy of the party state, refreshed from the web API.
// Before the first successful fetch nothing is active (fails closed); after
// that a failed refresh keeps the last state.
import { fetchParty, type PartyState } from "./webapi-client.ts";

let state: PartyState | null = null;
let outage = false;
let timer: ReturnType<typeof setInterval> | undefined;

const stamp = () => new Date().toISOString();
const names = (keys: readonly string[]) => (keys.length ? keys.map((k) => k.split("|")[1] ?? k).join(",") : "none");

export const partyState = (): PartyState | null => state;

export function activePartyNames(): readonly string[] {
  return state ? state.active.map((k) => k.split("|")[1] ?? k) : [];
}

function describe(s: PartyState): string {
  return `[${stamp()}] [PARTY] party state: mode=${s.mode} active=${names(s.active)}`;
}

export function setPartyState(s: PartyState): void {
  if (!state || JSON.stringify(state) !== JSON.stringify(s)) console.log(describe(s));
  state = s;
  outage = false;
}

export async function refreshParties(): Promise<void> {
  const next = await fetchParty();
  if (!next) {
    if (!outage) {
      outage = true;
      console.log(`[${stamp()}] [PARTY] web API unreachable, keeping ${state ? names(state.active) : "nothing"}`);
    }
    return;
  }
  const changed = !state || JSON.stringify(state) !== JSON.stringify(next);
  if (changed || outage) console.log(describe(next));
  state = next;
  outage = false;
}

export function startPartyRefresh(intervalMs = 60_000): void {
  stopPartyRefresh();
  void refreshParties();
  timer = setInterval(() => void refreshParties(), intervalMs);
  timer.unref();
}

export function stopPartyRefresh(): void {
  if (timer) clearInterval(timer);
  timer = undefined;
}
