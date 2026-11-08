// Coin costs from the game data (data/prices.json, generated from the
// client's static game data): consumables (by server name), equipment
// templates (making clothing), decorations and igloo structures. null for an id that has no cost.
import prices from "../../data/prices.json";

const table = prices as Record<"consumables" | "templates" | "decorations" | "structures", Record<string, number>>;

function lookup(kind: keyof typeof table, id: unknown, pattern = /^\d+$/): number | null {
    const key = String(id);
    if (!pattern.test(key) || !Object.hasOwn(table[kind], key)) return null;
    return table[kind][key]!;
}

export const consumableCost = (type: unknown) => lookup("consumables", type, /^[A-Za-z0-9_]+$/);

export const templateCost = (definitionId: unknown) => lookup("templates", definitionId);

/** DecorationType 0 is a decoration, 1 an igloo structure. */
export const decorationCost = (type: number, definitionId: unknown) =>
    type === 0 ? lookup("decorations", definitionId) : type === 1 ? lookup("structures", definitionId) : null;
