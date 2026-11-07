// Scene switches: the trees of ClubPenguin.Core.Switch objects that daily
// challenge watchers refer to by name (SwitchWatcher.SwitchName,
// UserGroupWatcher.Switches, TaskWatcher.CriteriaSwitchName). The client
// can only export them (ExportedSwitch: type, path, latch, parameters,
// children); the server decides whether each one is on for each player.
//
// data/scene-switches.json is generated from the game's scenes, per zone
// (the third field of the room name, e.g. "Town"). Volume colliders are
// exported like ExportUtils.GetColliderBounds, with their localToWorld
// matrix added.
//
// A switch's value is recomputed from what the server knows about the
// player: position (l.a), locomotion state ("loc" user variable), held item
// ("con"), outfit, tube, colour, the last thing they interacted with, and
// WatcherSwitch state. As in Switch.Change, a latched switch stays on once
// on (until the player leaves the room: the client resets switches with the
// scene).

import data from "../data/scene-switches.json" with { type: "json" };

export interface SwitchNode {
  type: string;
  path: string;
  latch: boolean;
  active: boolean;
  parameters: any;
  children: SwitchNode[];
}

interface Collider {
  type: "rotated_box" | "sphere" | "rotated_capsule";
  min?: number[];
  max?: number[];
  center?: number[];
  radius?: number[];
  heightAxis?: number;
  heightScale?: number;
  transform?: number[][];
  localToWorld?: number[][];
}

// A switch watcher event: the WatcherSwitch watchers it turns on or off.
export type WatcherMatch = (watcher: any) => boolean;

const ZONES = (data as any).zones as Record<string, Record<string, SwitchNode>>;
const TAGS = (data as any).tags as {
  templates: Record<string, string[]>;
  decals: Record<string, string[]>;
  fabrics: Record<string, string[]>;
  tubes: Record<string, string[]>;
  tagCategories: Record<string, string>;
};

// The local player's CharacterController: height 0.8, radius 0.2, centre
// 0.4 above the position l.a reports. Sampled at three heights.
const PLAYER_RADIUS = 0.2;
const PLAYER_SAMPLE_HEIGHTS = [0.2, 0.4, 0.6];
// l.a Move arrives about every 0.2 s while moving; the path between two
// positions is checked in steps so short volumes aren't skipped. Longer
// jumps (teleports, spawns) only check the end point.
const PATH_STEP = 0.5;
const MAX_PATH = 15;

// ==================== Zones ====================

export function zoneOfRoom(roomName: string): string {
  return roomName.split(":")[2] ?? "";
}

export function zoneSwitches(zone: string): Record<string, SwitchNode> | undefined {
  return ZONES[zone];
}

// ==================== Geometry ====================

type Mat = number[][];

function apply(m: Mat, p: number[]): number[] {
  return [0, 1, 2].map((i) => m[i]![0]! * p[0]! + m[i]![1]! * p[1]! + m[i]![2]! * p[2]! + m[i]![3]!);
}

function dist(a: number[], b: number[]): number {
  return Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!);
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

// Distance from a point to a collider (0 inside).
function colliderDistance(c: Collider, p: number[]): number {
  switch (c.type) {
    case "rotated_box": {
      const local = apply(c.transform!, p);
      const closest = local.map((v, i) => clamp(v, c.min![i]!, c.max![i]!));
      return dist(apply(c.localToWorld!, closest), p);
    }
    case "sphere":
      return Math.max(0, dist(c.center!, p) - Math.max(...c.radius!));
    case "rotated_capsule": {
      const local = apply(c.transform!, p);
      const axis = c.heightAxis ?? 1;
      const r = c.radius![0]!;
      const half = Math.max(0, c.heightScale! / 2 - r);
      const seg = [...c.center!];
      seg[axis] = clamp(local[axis]!, c.center![axis]! - half, c.center![axis]! + half);
      const d = dist(local, seg);
      if (d <= r) return 0;
      const closest = seg.map((v, i) => v + ((local[i]! - v) / d) * r);
      return dist(apply(c.localToWorld!, closest), p);
    }
  }
}

// World-space bounds, inflated by the player's size, to skip most tests.
interface Bounds {
  lo: number[];
  hi: number[];
}
const boundsCache = new WeakMap<Collider, Bounds>();

function colliderBounds(c: Collider): Bounds {
  let b = boundsCache.get(c);
  if (b) return b;
  let corners: number[][];
  if (c.type === "sphere") {
    const r = Math.max(...c.radius!);
    corners = [c.center!.map((v) => v - r), c.center!.map((v) => v + r)];
  } else {
    let lo: number[];
    let hi: number[];
    if (c.type === "rotated_box") {
      lo = c.min!;
      hi = c.max!;
    } else {
      const ext = [0, 1, 2].map((i) => (i === c.heightAxis ? c.heightScale! / 2 : c.radius![0]!));
      lo = c.center!.map((v, i) => v - ext[i]!);
      hi = c.center!.map((v, i) => v + ext[i]!);
    }
    corners = [];
    for (let i = 0; i < 8; i++) {
      corners.push(apply(c.localToWorld!, [i & 1 ? hi[0]! : lo[0]!, i & 2 ? hi[1]! : lo[1]!, i & 4 ? hi[2]! : lo[2]!]));
    }
  }
  const pad = PLAYER_RADIUS + Math.max(...PLAYER_SAMPLE_HEIGHTS);
  b = {
    lo: [0, 1, 2].map((i) => Math.min(...corners.map((p) => p[i]!)) - pad),
    hi: [0, 1, 2].map((i) => Math.max(...corners.map((p) => p[i]!)) + pad),
  };
  boundsCache.set(c, b);
  return b;
}

export function playerInVolume(colliders: Collider[], position: number[]): boolean {
  for (const c of colliders) {
    const b = colliderBounds(c);
    if (position.some((v, i) => v < b.lo[i]! || v > b.hi[i]!)) continue;
    for (const h of PLAYER_SAMPLE_HEIGHTS) {
      if (colliderDistance(c, [position[0]!, position[1]! + h, position[2]!]) <= PLAYER_RADIUS) return true;
    }
  }
  return false;
}

// ==================== Tag matchers ====================
// BaseTagMatcher / BaseOutfitTagMatcher.isMatch. MatchType 0 ANY, 1 ALL.

const ANY = 0;
const ALL = 1;

interface Matcher {
  matchType: number;
  tags: string[];
  categories: string[];
  templates?: number[];
  decals?: number[];
  fabrics?: number[];
}

// One piece of the outfit: template id plus decal/fabric ids
// (CustomEquipmentCustomization.type 0 DECAL, 1 FABRIC).
interface Equipment {
  definitionId: number;
  decals: number[];
  fabrics: number[];
}

function tagCollection(eqs: Equipment[]): string[][] {
  const out: string[][] = [];
  for (const e of eqs) {
    const t = TAGS.templates[String(e.definitionId)];
    if (!t) continue;
    const tags = [...t];
    for (const d of e.decals) tags.push(...(TAGS.decals[String(d)] ?? []));
    for (const f of e.fabrics) tags.push(...(TAGS.fabrics[String(f)] ?? []));
    if (tags.length) out.push(tags);
  }
  return out;
}

function collectionMatches(m: Matcher, collection: string[], wanted: string[], has: (c: string[], w: string) => boolean): boolean {
  if (collection.length === 0) return false;
  for (const w of wanted) {
    const found = has(collection, w);
    if (m.matchType === ALL && !found) return false;
    if (m.matchType === ANY && found) return true;
  }
  return m.matchType === ALL;
}

function tagsMatch(m: Matcher, collections: string[][]): boolean {
  if (!m.tags.length) return m.matchType === ALL;
  return collections.some((c) => collectionMatches(m, c, m.tags, (col, t) => col.includes(t)));
}

function categoriesMatch(m: Matcher, collections: string[][]): boolean {
  if (!m.categories.length) return m.matchType === ALL;
  return collections.some((c) => collectionMatches(m, c, m.categories, (col, cat) => col.some((t) => TAGS.tagCategories[t] === cat)));
}

function baseMatch(m: Matcher, collections: string[][]): boolean {
  if (m.matchType === ALL) return tagsMatch(m, collections) && categoriesMatch(m, collections);
  if (m.matchType === ANY) return tagsMatch(m, collections) || categoriesMatch(m, collections);
  return false;
}

// templatesMatch / decalsMatch / fabricsMatch.
function partsMatch(m: Matcher, eqs: Equipment[], ids: number[] | undefined, idsOf: (e: Equipment) => number[]): Equipment[] {
  if (!ids || !ids.length) return m.matchType === ALL ? eqs : [];
  const list: Equipment[] = [];
  for (const id of ids) {
    let found = false;
    for (const e of eqs) {
      if (!idsOf(e).includes(id)) continue;
      found = true;
      if (m.matchType === ALL) list.push(e);
      else if (m.matchType === ANY) return eqs;
    }
    if (!found && m.matchType === ALL) return [];
  }
  return list;
}

export function outfitMatches(m: Matcher, eqs: Equipment[]): boolean {
  const templates = (e: Equipment) => [e.definitionId];
  if (m.matchType === ANY) {
    return (
      partsMatch(m, eqs, m.templates, templates).length > 0 ||
      partsMatch(m, eqs, m.decals, (e) => e.decals).length > 0 ||
      partsMatch(m, eqs, m.fabrics, (e) => e.fabrics).length > 0 ||
      baseMatch(m, tagCollection(eqs))
    );
  }
  if (m.matchType === ALL) {
    let list = partsMatch(m, eqs, m.templates, templates);
    list = partsMatch(m, list, m.decals, (e) => e.decals);
    list = partsMatch(m, list, m.fabrics, (e) => e.fabrics);
    list = list.filter((e) => tagsMatch(m, tagCollection([e])));
    return list.length > 0 && baseMatch(m, tagCollection(list));
  }
  return false;
}

// PlayerOutfitDetails JSON: {sessionId, parts: CustomEquipment[]}, each
// {definitionId, parts: [{slotIndex, customizations: [{type, definitionId}]}]}.
const outfitCache = new Map<string, Equipment[]>();
export function parseOutfit(json: string | undefined): Equipment[] {
  if (!json) return [];
  let eqs = outfitCache.get(json);
  if (eqs) return eqs;
  eqs = [];
  try {
    const parsed = JSON.parse(json);
    for (const e of parsed?.parts ?? []) {
      const decals: number[] = [];
      const fabrics: number[] = [];
      for (const part of e?.parts ?? []) {
        for (const c of part?.customizations ?? []) {
          if (c?.type === 1 || c?.type === "FABRIC") fabrics.push(c.definitionId);
          else decals.push(c?.definitionId);
        }
      }
      eqs.push({ definitionId: e?.definitionId, decals, fabrics });
    }
  } catch {
    // Unparseable outfit: matches nothing.
  }
  if (outfitCache.size > 1000) outfitCache.clear();
  outfitCache.set(json, eqs);
  return eqs;
}

// ==================== Per-player state ====================

export interface PlayerInputs {
  position?: number[];
  // "loc": Domain.LocomotionState (0 Default, 1 Slide, 5 Sitting, 6 Zipline, 7 Racing).
  locomotionState: number;
  // NameOnServer of what's in "con".
  held?: string;
  outfit: Equipment[];
  tube?: number;
  colour?: number;
  // Path of the last object the player interacted with (l.a Interact on a
  // LOCAL object). SwitchInteraction stays on until another interaction.
  lastInteraction?: string;
}

// Root values before and after one evaluation, by switch name.
export interface SwitchChange {
  name: string;
  before: boolean;
  after: boolean;
}

export class PlayerSwitches {
  readonly zone: string;
  readonly trees: Record<string, SwitchNode>;
  // Current value per switch path.
  private values = new Map<string, boolean>();
  private watcherOn = new Map<string, boolean>();
  private seqIndex = new Map<string, number>();

  constructor(zone: string) {
    this.zone = zone;
    this.trees = ZONES[zone] ?? {};
  }

  has(name: string): boolean {
    return name in this.trees;
  }

  isOn(name: string): boolean {
    const t = this.trees[name];
    return t ? this.values.get(t.path) === true : false;
  }

  nodeOn(node: SwitchNode): boolean {
    return this.values.get(node.path) === true;
  }

  // Re-evaluates every tree. Returns the roots whose value changed.
  evaluate(inputs: PlayerInputs): SwitchChange[] {
    const before = new Map<string, boolean>();
    for (const [name, t] of Object.entries(this.trees)) before.set(name, this.values.get(t.path) === true);
    const next = new Map<string, boolean>();
    for (const t of Object.values(this.trees)) this.evalNode(t, inputs, next);
    for (const [k, v] of next) this.values.set(k, v);
    const changes: SwitchChange[] = [];
    for (const [name, t] of Object.entries(this.trees)) {
      const after = this.values.get(t.path) === true;
      if (after !== before.get(name)) changes.push({ name, before: before.get(name)!, after });
    }
    return changes;
  }

  // Applies a watcher event to every WatcherSwitch: an enable watcher that
  // matches turns it on, a disable watcher turns it off. Returns whether
  // anything changed (the caller then re-evaluates).
  applyWatcherEvent(match: WatcherMatch): boolean {
    let changed = false;
    const visit = (n: SwitchNode) => {
      if (n.type === "watcher" && n.active) {
        const p = n.parameters ?? {};
        if ((p.enable ?? []).some((w: any) => this.criteriaOn(w) && match(w)) && !this.watcherOn.get(n.path)) {
          this.watcherOn.set(n.path, true);
          changed = true;
        }
        if ((p.disable ?? []).some((w: any) => this.criteriaOn(w) && match(w)) && this.watcherOn.get(n.path)) {
          this.watcherOn.set(n.path, false);
          changed = true;
        }
      }
      n.children.forEach(visit);
    };
    Object.values(this.trees).forEach(visit);
    return changed;
  }

  // A watcher with a criteriaSwitch only counts while that switch is on
  // (TaskWatcher.taskIncrement); one that isn't in this scene never counts.
  criteriaOn(watcher: { criteriaSwitch?: string }): boolean {
    return !watcher.criteriaSwitch || this.isOn(watcher.criteriaSwitch);
  }

  private evalNode(n: SwitchNode, inputs: PlayerInputs, next: Map<string, boolean>): boolean {
    const memo = next.get(n.path);
    if (memo !== undefined) return memo;
    const kids = n.children.map((c) => this.evalNode(c, inputs, next));
    let value = n.active && this.raw(n, kids, inputs, next);
    if (n.latch && this.values.get(n.path)) value = true;
    next.set(n.path, value);
    return value;
  }

  private raw(n: SwitchNode, kids: boolean[], inputs: PlayerInputs, next: Map<string, boolean>): boolean {
    const p = n.parameters;
    switch (n.type) {
      case "compound":
        return p === "AND" ? kids.length > 0 && kids.every(Boolean) : kids.some(Boolean);
      case "childInverse":
        return kids.length > 0 && !kids[0];
      case "eventInverse": {
        const src = typeof p === "string" ? this.trees[p] : undefined;
        return src ? !this.evalNode(src, inputs, next) : false;
      }
      case "sequential": {
        // SequentialSwitch: children switch on one after another; on when
        // the last one is.
        let i = this.seqIndex.get(n.path) ?? 0;
        while (i < kids.length - 1 && kids[i]) i++;
        this.seqIndex.set(n.path, i);
        return i === kids.length - 1 && kids[i] === true;
      }
      case "volume":
        return inputs.position !== undefined && playerInVolume(p?.colliders ?? [], inputs.position);
      case "locomotionState":
        return Array.isArray(p) && p.includes(inputs.locomotionState);
      case "equipped":
        // PropSwitch.onHeldObjectChanged: on while holding one of the props.
        return inputs.held !== undefined && (p?.equippedIds ?? []).includes(inputs.held);
      case "equippedOutfit":
        return p ? outfitMatches(p, inputs.outfit) : false;
      case "selectedTube": {
        if (inputs.tube === undefined) return false;
        if ((p?.tubes ?? []).includes(inputs.tube)) return true;
        const m: Matcher | undefined = p?.tags;
        if (!m || (!m.tags.length && !m.categories.length)) return false;
        return baseMatch(m, [TAGS.tubes[String(inputs.tube)] ?? []]);
      }
      case "selectedColour":
        // "If empty matches anything".
        return inputs.colour !== undefined && (!Array.isArray(p) || p.length === 0 || p.includes(inputs.colour));
      case "interaction":
        return inputs.lastInteraction !== undefined && inputs.lastInteraction === p;
      case "watcher":
        return this.watcherOn.get(n.path) === true;
      default:
        // interactiveZone and the switch types the client can't export
        // ("client-only:...") have no server-side state.
        return false;
    }
  }
}

// Positions to evaluate for a move from `from` to `to`: intermediate points
// along the path, then `to`.
export function pathSamples(from: number[] | undefined, to: number[]): number[][] {
  if (!from) return [to];
  const d = dist(from, to);
  if (d <= PATH_STEP || d > MAX_PATH) return [to];
  const steps = Math.ceil(d / PATH_STEP);
  const out: number[][] = [];
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    out.push([0, 1, 2].map((k) => from[k]! + (to[k]! - from[k]!) * t));
  }
  return out;
}

// SwitchWatcher counting for a task whose goal is above 1 and whose switch
// can't go back off once on (an OR with a latched child, or an AND latched
// all the way down): such a root only rises once, so the parts are counted
// instead - each latched leaf the player has turned on counts once.
export function sticksOn(n: SwitchNode): boolean {
  if (n.latch) return true;
  if (n.type !== "compound" || n.children.length === 0) return false;
  return n.parameters === "AND" ? n.children.every(sticksOn) : n.children.some(sticksOn);
}

export function countedParts(root: SwitchNode): SwitchNode[] {
  const out: SwitchNode[] = [];
  const collect = (n: SwitchNode) => {
    for (const c of n.children) {
      const before = out.length;
      collect(c);
      if (out.length === before && sticksOn(c)) out.push(c);
    }
  };
  collect(root);
  return out;
}
