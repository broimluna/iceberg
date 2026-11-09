// Party game templates (PartyGameDefinition), generated from the game's
// static data exports into data/party-games.json. Template ids are the
// client's PartyGameDefinition.GameTypes; prop ids are already resolved to
// NameOnServer, which is what "con" carries.
import data from "../../data/party-games.json" with { type: "json" };
import tubeData from "../../data/tube-races.json" with { type: "json" };

export interface PartyGameReward {
  coins?: number;
  mascotXP?: Record<string, number>;
}

export interface PartyGameDef {
  id: number;
  gameType: number;
  lobbyType: number;
  minPlayers: number;
  maxPlayers: number;
  numTeams: number;
  gameData: Record<string, unknown>;
  lobbyData: Record<string, unknown>;
  rewards: { placement: number; reward: PartyGameReward }[];
  launcher: {
    method: number;
    triggerProp: string | null;
    lobbyProp: string | null;
    scheduledZone: string | null;
    everyXMinutes: number;
  } | null;
  playerProp: string | null;
}

const games = new Map<number, PartyGameDef>();
const byTrigger = new Map<string, number>();
for (const def of Object.values(data as Record<string, PartyGameDef>)) {
  games.set(def.id, def);
  if (def.launcher?.triggerProp) byTrigger.set(def.launcher.triggerProp, def.id);
}

export function getPartyGame(templateId: number): PartyGameDef | undefined {
  return games.get(templateId);
}

// The template a party-game invitation consumable (e.g. "FindFourGroup") starts.
export function templateForTrigger(propName: string): number | undefined {
  return byTrigger.get(propName);
}

export function rewardFor(def: PartyGameDef, placement: number): PartyGameReward | undefined {
  return def.rewards.find((r) => r.placement === placement)?.reward;
}

// Games a zone schedule launches (launcher method 1: ZoneSchedule).
export function scheduledGames(): PartyGameDef[] {
  return [...games.values()].filter((g) => g.launcher?.method === 1 && g.launcher.everyXMinutes > 0 && !!g.launcher.scheduledZone);
}

// Tube race score modifiers (Mt Blizzard scene: TubeRaceScoreModifierLayout
// children), in data/tube-races.json. Positions are world space.
export interface TubeRaceModifier {
  id: number;
  delta: number;
  pos: [number, number, number];
}

const tubeLayouts = new Map<number, Map<number, TubeRaceModifier[]>>();
for (const [template, { layouts }] of Object.entries(tubeData as Record<string, { layouts: Record<string, TubeRaceModifier[]> }>)) {
  tubeLayouts.set(Number(template), new Map(Object.entries(layouts).map(([id, mods]) => [Number(id), mods])));
}

// Layout id -> modifiers; empty for a template without a race.
export function tubeRaceLayouts(templateId: number): Map<number, TubeRaceModifier[]> {
  return tubeLayouts.get(templateId) ?? new Map();
}
