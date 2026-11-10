// What a player looks like, as the web API has it saved: the colour, the
// equipped tube and the worn clothing. The outfit endpoint answers with it,
// and the game server asks for it (/api/internal/appearance) to check what a
// client says about itself, since the client is the one relaying these
// values to the other players in its room.
import * as db from "../database.ts";

export interface OutfitPart {
    equipmentId: number;
    dateTimeCreated: number;
    definitionId: number;
    parts: number[];
}

/** The worn items among the account's own equipment (ids it doesn't own never appear). */
export function outfitParts(username: string): OutfitPart[] {
    const worn = db.getOutfit(username);
    return db.getEquipment(username)
        .filter((eq) => worn.includes(eq.equipmentId))
        .map((eq) => ({
            equipmentId: eq.equipmentId,
            dateTimeCreated: eq.dateTimeCreated,
            definitionId: eq.definitionId,
            parts: eq.parts || [],
        }));
}

export const DEFAULT_COLOUR = 3235500;

export function appearanceOf(username: string): { colour: number; tubeId: number; parts: OutfitPart[] } {
    return {
        colour: db.getPlayerProfile(username).colour ?? DEFAULT_COLOUR,
        tubeId: db.getEquippedTube(username),
        parts: outfitParts(username),
    };
}
