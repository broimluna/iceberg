// Party calendar rules: date ranges, overrides, validation of the data file.
import { makeChecker } from "./lib/harness.ts";
import { calendar, keyOf, inRange, activeParties, resolveParty, parseCalendar, loadCalendar, type CalendarEntry } from "../web-api/src/services/parties.ts";

const { check, finish } = makeChecker();
const d = (s: string) => new Date(s);
const cal = calendar();
const ids = (l: CalendarEntry[]) => l.map((e) => e.id).sort((a, b) => a - b);

check(cal.length === 27, "shipped calendar has 27 entries");
check(keyOf(cal.find((e) => e.id === 47)!) === "47|halloween2026", "key of id 47");

const h = { id: 1, name: "x", start: "10-24", end: "11-02", calendar: true };
check(inRange(h, d("2026-10-24T00:00:00Z")), "start inclusive");
check(inRange(h, d("2026-11-01T23:59:00Z")), "last minute in");
check(!inRange(h, d("2026-10-23T23:59:00Z")), "before start out");
check(!inRange(h, d("2026-11-02T00:00:00Z")), "end exclusive");

const w = { id: 2, name: "y", start: "12-01", end: "01-04", calendar: true };
check(inRange(w, d("2026-12-01T00:00:00Z")), "wrap: 12-01 in");
check(inRange(w, d("2026-12-31T12:00:00Z")), "wrap: 12-31 in");
check(inRange(w, d("2027-01-01T00:00:00Z")), "wrap: 01-01 in");
check(inRange(w, d("2027-01-03T23:59:00Z")), "wrap: 01-03 in");
check(!inRange(w, d("2027-01-04T00:00:00Z")), "wrap: 01-04 out");
check(!inRange(w, d("2026-11-30T12:00:00Z")), "wrap: 11-30 out");

const auto = { mode: "auto" as const };
check(activeParties(cal, auto, d("2026-11-09T12:00:00Z")).length === 0, "auto: nothing on 11-09");
check(activeParties(cal, auto, d("2026-11-24T12:00:00Z")).map(keyOf).join() === "35|holidayconstruction", "auto: 11-24 holiday construction");
check(JSON.stringify(ids(activeParties(cal, auto, d("2026-04-10T12:00:00Z")))) === "[17,27,29]", "auto: overlap on 04-10 is 17,27,29");
check(!activeParties(cal, auto, d("2026-07-04T12:00:00Z")).some((e) => e.id === 55), "auto: carworld (calendar false) never by date");
check(activeParties(cal, { mode: "party", party: "55|carworld" }, d("2026-11-09T00:00:00Z")).map(keyOf).join() === "55|carworld", "party mode: carworld");
check(activeParties(cal, { mode: "none" }, d("2026-11-24T00:00:00Z")).length === 0, "none mode");
check(activeParties(cal, { mode: "party", party: "99|gone" }, d("2026-11-24T00:00:00Z")).length === 0, "party mode, removed party: nothing");

check(resolveParty(cal, "HALLOWEEN2026")?.id === 47, "resolve by name, any case");
check(resolveParty(cal, "47")?.id === 47, "resolve by id");
check(resolveParty(cal, "47|halloween2026")?.id === 47, "resolve by key");
check(resolveParty(cal, "48|halloween2026") === undefined, "mismatched key");
check(resolveParty(cal, "") === undefined, "empty");

const good = { id: 100, name: "good", start: "01-01", end: "01-02", calendar: true };
const bad: any[] = [
  { ...good, id: 0, name: "a1" }, { ...good, id: "5", name: "a2" }, { ...good, name: "Bad Name", id: 101 },
  { ...good, id: 102, name: "a3", start: "02-29" }, { ...good, id: 103, name: "a4", start: "13-01" },
  { ...good, id: 104, name: "a5", end: "04-31" }, { ...good, name: "a6" }, { ...good, id: 105 },
  { ...good, id: 106, name: "a7", calendar: "yes" },
];
const logs: string[] = [];
const parsed = parseCalendar([good, ...bad], (m) => logs.push(m));
check(parsed.length === 1 && parsed[0]!.id === 100, "parse keeps only the good entry");
check(logs.length === bad.length, `one log line per dropped entry (${logs.length})`);
const l2: string[] = [];
check(parseCalendar({ not: "array" }, (m) => l2.push(m)).length === 0 && l2.length === 1, "non-array gives [] and one log line");

const origLog = console.log; console.log = () => {};
const a = loadCalendar("/nonexistent/party.json");
const p = `${process.env.TMPDIR ?? "/tmp"}/party-bad-${process.pid}.json`;
await Bun.write(p, "{");
const b = loadCalendar(p);
console.log = origLog;
check(a.length === 0 && b.length === 0, "unreadable or invalid file gives []");

finish();
