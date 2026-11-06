/**
 * Server Configuration
 *
 * Centralized configuration for the CPI Web API.
 * Environment variables can override defaults for production deployment.
 *
 * Data files are synced from ReferenceProjects/cpi-web-service/src/main/resources/
 */

// =============================================================================
// Data File Loading - Bun loads .json modules natively, no fs boilerplate needed
// =============================================================================

import questsData from "../data/quests.json";
import claimableRewardsData from "../data/ClaimableReward.json";
import dailySpinData from "../data/DailySpin.json";
import progressionXPData from "../data/ProgressionMascotLevelXP.json";
import collectibleDefinitionData from "../data/CollectibleDefinition.json";
import pickupablesData from "../data/pickupables.json";

console.log(`[CONFIG] Loaded quests.json, ClaimableReward.json, DailySpin.json, ProgressionMascotLevelXP.json, CollectibleDefinition.json, pickupables.json`);

// Build collectible exchange rates map from reference data
const collectibleExchangeRates: Record<string, number> = {};
for (const collectible of collectibleDefinitionData as any[]) {
    collectibleExchangeRates[collectible.CollectibleType] = collectible.ExchangeRate;
}
console.log(`[CONFIG] Loaded ${Object.keys(collectibleExchangeRates).length} collectible exchange rates`);

// Build pickupables map for room rewards
// Maps room name -> path -> reward definition
const pickupablesMap: Record<string, unknown> = pickupablesData;
console.log(`[CONFIG] Loaded pickupables for ${Object.keys(pickupablesMap).length} rooms`);

// Build mascot XP thresholds from reference data
const mascotXPThresholds: Record<string, number[]> = {};
for (const mascotData of progressionXPData as any[]) {
    mascotXPThresholds[mascotData.Mascot] = mascotData.Levels;
}
// Ensure all mascots have thresholds (fallback for missing ones)
const defaultThresholds = [0, 60, 190, 390, 610, 830, 1065, 1315, 1580, 1860];
for (const mascot of ['AuntArctic', 'Rockhopper', 'Rookie', 'DJCadence']) {
    if (!mascotXPThresholds[mascot]) {
        mascotXPThresholds[mascot] = defaultThresholds;
    }
}

console.log(`[CONFIG] Loaded ${Object.keys(questsData).length} quest definitions`);
console.log(`[CONFIG] Loaded ${claimableRewardsData.length} claimable reward definitions`);
console.log(`[CONFIG] Mascot XP thresholds: ${Object.keys(mascotXPThresholds).join(', ')}`)

const config = {
    // Server settings
    server: {
        port: process.env.PORT || 3000,
        host: process.env.HOST || '0.0.0.0'
    },

    // Game server connection settings (SFS2X)
    gameServer: {
        ip: process.env.GAME_SERVER_IP || '127.0.0.1',
        tcpPort: process.env.GAME_SERVER_PORT || 9933,
        httpsPort: 8443
    },

    // Session file path for SFS2X integration
    sessionFile: process.env.SESSION_FILE || '',

    // Shared secret for the internal (server-to-server only) endpoints -
    // /api/internal/add-coins and /api/internal/grant-reward. Optional:
    // both endpoints are already restricted to localhost callers
    // regardless (see server.ts's isInternalCaller); this is an extra
    // check for deployments where that's not enough, not a requirement.
    internalApiSecret: process.env.INTERNAL_API_SECRET || '',

    // Database settings
    database: {
        path: process.env.DB_PATH || "cpi_data.db",
        verbose: process.env.DB_VERBOSE === 'true'
    },

    // Content identifiers
    content: {
        clientVersion: '1.13.0',
        contentVersion: 'live',
        subContentVersion: '2025-12-31',
        abTestGroup: 'NONE'
    },

    // Default player values
    defaults: {
        startingCoins: 1000,
        profileColour: 3235500,
        daysOld: 1,
        defaultDurable: 15
    },

    // Quest reward values
    rewards: {
        questCompletionXP: 100,
        questCompletionCoins: 50,
        objectiveXP: 25,
        welcomeKitCoins: 500,
        welcomeKitTemplates: [1, 2, 3],
        welcomeKitXP: 100
    },

    // Mascot XP level thresholds - loaded from ProgressionMascotLevelXP.json
    // These are cumulative XP amounts needed to reach each level
    mascotXPThresholds: mascotXPThresholds as Record<string, number[]>,

    // Collectible exchange rates - loaded from CollectibleDefinition.json
    // Maps collectible type to coin exchange rate (e.g., Shell: 0.25 means 4 shells = 1 coin)
    collectibleExchangeRates: collectibleExchangeRates,

    // Room pickupables - loaded from pickupables.json
    // Maps room name -> path -> reward definition for collectible items in each room
    pickupables: pickupablesMap,

    // Reward definitions for claimable rewards
    // Reward IDs map to ClaimableRewardDefinition assets in the client
    rewardDefinitions: {
        // Blizzard Beach - Snow Slider tube and swimwear
        3: { name: 'BlizzardBeach', equipmentTemplates: [289, 290], emotePacks: ['Sunshine', 'SummertimePenguin', 'SnowTuberPenguin'], tubes: [13] },
        // Water Weekend - Ducky Tube
        17: { name: 'WaterWeekend', tubes: [14] },
        // Tester T-Shirt - given to testers
        19: { name: 'TesterTshirt', equipmentTemplates: [357], emotePacks: [] },
        // Color Event 2018 - Majesteed tube
        20: { name: 'ColorEvent2018', decals: [187, 188, 189], fabrics: [270, 271, 272], tubes: [15] },
        // Welcome Tee - given to new players (Level 1 T-shirt)
        23: { name: 'WelcomeTee', equipmentTemplates: [352], emotePacks: [] },
        // Splashdown - Ducky Mallard tube
        29: { name: 'Splashdown', emotePacks: ['FrozenYogurt', 'Octopus', 'Surfboard'], tubes: [17] },
        // WaddleOn 2018 - sunset hat and toot emote
        34: { name: 'WaddleOn2018', equipmentTemplates: [392], emotePacks: ['Toot'] },
        // Anniversary 2019 reward
        35: { name: 'Anniversary19', equipmentTemplates: [393], emotePacks: [] },
        // Holiday 2024 reward - includes Blue, Pink, Green Duck Tubes
        36: { name: 'Holiday2024', equipmentTemplates: [394], emotePacks: [], tubes: [19, 20, 21] },
        // New Years 2025 reward - includes Purple Duck Tube
        37: { name: 'NewYears2025', equipmentTemplates: [395], emotePacks: [], tubes: [22] },
        // Unreleased Blueprints reward
        38: { name: 'UnreleasedBlueprints', equipmentTemplates: [396], emotePacks: [] },
        // Lava Suit - from Lava quest objective
        137: { name: 'LavaSuit', equipmentTemplates: [137], emotePacks: [] },
        // Flame Hair - from Lava quest completion
        165: { name: 'FlameHair', equipmentTemplates: [165], emotePacks: [] }
    } as Record<number, { name: string; equipmentTemplates?: number[]; emotePacks?: string[]; decals?: number[]; fabrics?: number[]; tubes?: number[] }>,

    // Consumable prices
    consumablePrices: {
        HotChocolateSingle: 10,
        HotCocoa: 10,
        PizzaSliceSingle: 10,
        PizzaSlice: 10,
        StinkyCheese: 10,
        FroYoCone: 10,
        FireworksSingle: 10,
        Fireworks: 10,
        CakeSliceSingle: 10,
        CakeSlice: 10,
        InkOrSwim: 40,
        MarbleHunt: 30,
        SeaweedSmoothie: 10,
        FossilFour: 30,
        CocoaTray: 5,
        FroYoTray: 5,
        LargePizza: 5,
        Pinata: 10,
        FireworksXL: 15,
        HydroHydrant: 15,
        ChemistryBeaker: 25,
        PartyBlaster: 10,
        PartyBlasterJr: 25,
        CheeseWheel: 5,
        BirthdayCake: 5,
        PartyBlastXL: 12
    } as Record<string, number>,

    // Quest definitions - dynamically generated from quests.json
    // This ensures ALL quests in the game are properly handled
    // Local overrides can be specified for special cases (like FTUE level requirement)
    questDefinitions: {} as Record<string, any>,

    // Local quest overrides - these take precedence over loaded data
    // Use this for special cases like FTUE quest requirements
    questOverrides: {
        // FTUE Tutorial Quest - must have levelRequirement: 0
        'AAC001Q001LeakyShip': { levelRequirement: 0 }
    } as Record<string, any>,

    // Claimable rewards - loaded from ClaimableReward.json
    claimableRewards: claimableRewardsData as any[],

    // Daily spin configuration - loaded from DailySpin.json
    dailySpinConfig: (dailySpinData as any[]).length > 0 ? (dailySpinData as any[])[0] : null,

    // Legacy daily spin configuration (simplified version)
    // The full dailySpinConfig above contains the complete reference data
    dailySpin: {
        initialChestWeight: 5,
        chestWeightIncreasePerSpin: 5,
        outcomes: [
            { id: 2, type: 'mascotXP', mascot: 'AuntArctic', xp: 20, weight: 25 },
            { id: 3, type: 'mascotXP', mascot: 'DJCadence', xp: 20, weight: 25 },
            { id: 4, type: 'mascotXP', mascot: 'Rockhopper', xp: 20, weight: 25 },
            { id: 5, type: 'mascotXP', mascot: 'Rookie', xp: 20, weight: 25 },
            { id: 6, type: 'coins', coins: 25, weight: 25 },
            { id: 7, type: 'coins', coins: 100, weight: 25 }
        ],
        chestDefinitions: [
            { id: 0, name: 'Bronze', numPunchesPerChest: 3, coins: 200 },
            { id: 1, name: 'Silver', numPunchesPerChest: 5, coins: 350 },
            { id: 2, name: 'Gold', numPunchesPerChest: 7, coins: 500 },
            { id: 3, name: 'Platinum', numPunchesPerChest: 7, coins: 750 },
            { id: 4, name: 'Diamond', numPunchesPerChest: 7, coins: 1000 },
            { id: 5, name: 'Eternal', numPunchesPerChest: 7, coins: 1500 }
        ]
    }
};

// =============================================================================
// Quest Definition Population - Load ALL quests from quests.json
// =============================================================================

// Populate quest definitions from the loaded quests.json data
// This ensures EVERY quest in the game is properly handled
for (const [questId, questData] of Object.entries(questsData as Record<string, any>)) {
    config.questDefinitions[questId] = {
        // Core quest data from quests.json
        mascot: questData.mascot,
        isMemberOnly: questData.isMemberOnly || false,
        levelRequirement: questData.preReqProgressLevel || 0,
        prerequisites: questData.preReqQuests || [],
        objectives: questData.objectives || {},
        completeReward: questData.completeReward || null,
        startReward: questData.startReward || null,
        timeLockedSeconds: questData.timeLockedSeconds || 0
    };

    // Apply local overrides if any exist
    const override = config.questOverrides[questId];
    if (override) {
        Object.assign(config.questDefinitions[questId], override);
    }
}

export default config;
