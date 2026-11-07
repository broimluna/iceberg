// Consumables (PropType 0) from the game's PropDefinition data, keyed by
// NameOnServer, which is what con.use / con.reuse carry.
//
// experience is the client's PropDefinition.ConsumableExperience:
// - oneShot: plays on the user only (fireworks, snacks).
// - playerHeld: a held, possibly shareable item (trays, glowstick packs).
// - world: dropped into the room as an MMO item (party blasters, pinatas).
// - partyGameLobby: starts a party game lobby.
// serverAdded items are handed out by the server and never sent in con.use.
// World fields: timeToLive (s), actionCount (0 = "timed" template, else
// "actioned"), rewardRadius, and the TotalReward / MinPerPlayerReward coins.

export type ConsumableExperience = "oneShot" | "playerHeld" | "world" | "partyGameLobby";

export interface ConsumableDef {
  experience: ConsumableExperience;
  timeToLive?: number;
  actionCount?: number;
  rewardRadius?: number;
  totalCoins?: number;
  minCoins?: number;
  questOnly?: boolean;
  serverAdded?: boolean;
}

export const CONSUMABLES: Record<string, ConsumableDef> = {
  BirthdayCakeGroup: { experience: "playerHeld" },
  BirthdayCakeServerAdded: { experience: "playerHeld", serverAdded: true },
  BirthdayCakeSingle: { experience: "oneShot" },
  Firework: { experience: "oneShot" },
  HotChocolateSingle: { experience: "oneShot" },
  HotChocolateServerAdded: { experience: "playerHeld", serverAdded: true },
  HotChocolateGroup: { experience: "playerHeld" },
  PizzaGroup: { experience: "playerHeld" },
  PartyBlaster: { experience: "world", timeToLive: 5, actionCount: 0, rewardRadius: 2, totalCoins: 25, minCoins: 1 },
  Pinata: { experience: "world", timeToLive: 30, actionCount: 5, rewardRadius: 3.5, totalCoins: 50, minCoins: 1 },
  PizzaServerAdded: { experience: "playerHeld", serverAdded: true },
  PizzaSingle: { experience: "oneShot" },
  QuestFirework: { experience: "oneShot", questOnly: true },
  QuestStinkyCheeseTray: { experience: "playerHeld", questOnly: true },
  SquidStickServerAdded: { experience: "playerHeld", serverAdded: true },
  SquidStickSingle: { experience: "oneShot" },
  SquidStickGroup: { experience: "playerHeld" },
  StinkyCheeseServerAdded: { experience: "playerHeld", serverAdded: true },
  StinkyCheeseTray: { experience: "playerHeld" },
  SeaweedSmoothieSingle: { experience: "oneShot" },
  MegaPartyBlaster: { experience: "world", timeToLive: 5, actionCount: 0, rewardRadius: 3.5, totalCoins: 100, minCoins: 1 },
  SuperPartyBlaster: { experience: "world", timeToLive: 5, actionCount: 0, rewardRadius: 2.5, totalCoins: 50, minCoins: 1 },
  GlowStickYellow: { experience: "oneShot" },
  GlowStickPink: { experience: "oneShot" },
  GlowStickRainbow: { experience: "oneShot" },
  FishdogSingle: { experience: "oneShot" },
  FishdogGroup: { experience: "playerHeld" },
  FishdogServerAdded: { experience: "playerHeld", serverAdded: true },
  GlowstickPack: { experience: "playerHeld" },
  GlowStickServerAdded: { experience: "playerHeld", serverAdded: true },
  StinkyCheeseSingle: { experience: "oneShot" },
  PizzaPlanetGroup: { experience: "playerHeld" },
  PizzaPlanetServerAdded: { experience: "playerHeld", serverAdded: true },
  ZootopiaPawpsicle: { experience: "oneShot" },
  FindingDoryBubbleWand: { experience: "oneShot" },
  MonstersScareCanister: { experience: "oneShot" },
  FrozenSnowflake: { experience: "oneShot" },
  SuperFirework: { experience: "oneShot" },
  FireHydrant: { experience: "oneShot" },
  SeaweedSmoothieTray: { experience: "playerHeld" },
  SeaweedSmoothieServerAdded: { experience: "playerHeld", serverAdded: true },
  ScavengerHuntGroup: { experience: "partyGameLobby" },
  FishBucketGroup: { experience: "partyGameLobby" },
  FindFourGroup: { experience: "partyGameLobby" },
  SpicyPizzaGroup: { experience: "playerHeld" },
  SpicyPizzaServerAdded: { experience: "playerHeld", serverAdded: true },
  SpicyPizzaSingle: { experience: "oneShot" },
  HalloweenBasketTray: { experience: "playerHeld" },
  HalloweenBasketServerAdded: { experience: "playerHeld", serverAdded: true },
  HalloweenBasketOrange: { experience: "oneShot" },
  HalloweenBasketPurple: { experience: "oneShot" },
  HalloweenBasketGreen: { experience: "oneShot" },
  GlowStickRainbowNonMember: { experience: "oneShot" },
  HotChocolateGroupNonMember: { experience: "playerHeld" },
  PizzaGroupNonMember: { experience: "playerHeld" },
  SquidStickGroupNonMember: { experience: "playerHeld" },
  SuperFireworkNonMember: { experience: "oneShot" },
  HolidayPartyBlaster: { experience: "world", timeToLive: 5, actionCount: 0, rewardRadius: 2, totalCoins: 25, minCoins: 1 },
  HolidayFirework: { experience: "oneShot" },
  CandyCaneSingle: { experience: "oneShot" },
  CandyCane: { experience: "playerHeld" },
  CandyCaneServerAdded: { experience: "playerHeld", serverAdded: true },
  FluffyCakeSingle: { experience: "oneShot" },
  FluffyCakeTray: { experience: "playerHeld" },
  FluffyCakeServerAdded: { experience: "playerHeld", serverAdded: true },
  RainbowSmoothieSingle: { experience: "oneShot" },
  RainbowSmoothieTray: { experience: "playerHeld" },
  RainbowSmoothieServerAdded: { experience: "playerHeld", serverAdded: true },
  Science_BeakerSingle: { experience: "oneShot" },
  HotChocolateSingleNonMember: { experience: "oneShot" },
  BirthdayCakeSingleNonMember: { experience: "oneShot" },
  PizzaSingleNonMember: { experience: "oneShot" },
  FireworkNonMember: { experience: "oneShot" },
  FishdogSingleNonMember: { experience: "oneShot" },
  BirthdayCakeGroupNonMember: { experience: "playerHeld" },
  PinataNonMember: { experience: "world", timeToLive: 30, actionCount: 5, rewardRadius: 3.5, totalCoins: 50, minCoins: 1 },
  PartyBlasterNonMember: { experience: "world", timeToLive: 5, actionCount: 0, rewardRadius: 2, totalCoins: 25, minCoins: 1 },
  MegaPartyBlasterNonMember: { experience: "world", timeToLive: 5, actionCount: 0, rewardRadius: 3.5, totalCoins: 100, minCoins: 1 },
  FireHydrantNonMember: { experience: "oneShot" },
  Science_BeakerSingle_NonMember: { experience: "oneShot" },
  IceCreamTray: { experience: "playerHeld" },
  IceCreamServerAdded: { experience: "playerHeld", serverAdded: true },
  IceCreamSingle: { experience: "oneShot" },
  Popscorn: { experience: "oneShot" },
  PopscornServerAdded: { experience: "playerHeld", serverAdded: true },
  PopscornTray: { experience: "playerHeld" },
};
