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
// Every non-server-added playerHeld consumable is shareable: a tray of
// totalItemQuantity items, each taken as a `recipient` consumable.

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
  totalItemQuantity?: number;
  recipient?: string;
}

export const CONSUMABLES: Record<string, ConsumableDef> = {
  BirthdayCakeGroup: { experience: "playerHeld", totalItemQuantity: 6, recipient: "BirthdayCakeServerAdded" },
  BirthdayCakeServerAdded: { experience: "playerHeld", serverAdded: true },
  BirthdayCakeSingle: { experience: "oneShot" },
  Firework: { experience: "oneShot" },
  HotChocolateSingle: { experience: "oneShot" },
  HotChocolateServerAdded: { experience: "playerHeld", serverAdded: true },
  HotChocolateGroup: { experience: "playerHeld", totalItemQuantity: 6, recipient: "HotChocolateServerAdded" },
  PizzaGroup: { experience: "playerHeld", totalItemQuantity: 6, recipient: "PizzaServerAdded" },
  PartyBlaster: { experience: "world", timeToLive: 5, actionCount: 0, rewardRadius: 2, totalCoins: 25, minCoins: 1 },
  Pinata: { experience: "world", timeToLive: 30, actionCount: 5, rewardRadius: 3.5, totalCoins: 50, minCoins: 1 },
  PizzaServerAdded: { experience: "playerHeld", serverAdded: true },
  PizzaSingle: { experience: "oneShot" },
  QuestFirework: { experience: "oneShot", questOnly: true },
  QuestStinkyCheeseTray: { experience: "playerHeld", totalItemQuantity: 6, recipient: "StinkyCheeseSlice", questOnly: true },
  SquidStickServerAdded: { experience: "playerHeld", serverAdded: true },
  SquidStickSingle: { experience: "oneShot" },
  SquidStickGroup: { experience: "playerHeld", totalItemQuantity: 6, recipient: "SquidStickServerAdded" },
  StinkyCheeseServerAdded: { experience: "playerHeld", serverAdded: true },
  StinkyCheeseTray: { experience: "playerHeld", totalItemQuantity: 6, recipient: "StinkyCheeseServerAdded" },
  SeaweedSmoothieSingle: { experience: "oneShot" },
  MegaPartyBlaster: { experience: "world", timeToLive: 5, actionCount: 0, rewardRadius: 3.5, totalCoins: 100, minCoins: 1 },
  SuperPartyBlaster: { experience: "world", timeToLive: 5, actionCount: 0, rewardRadius: 2.5, totalCoins: 50, minCoins: 1 },
  GlowStickYellow: { experience: "oneShot" },
  GlowStickPink: { experience: "oneShot" },
  GlowStickRainbow: { experience: "oneShot" },
  FishdogSingle: { experience: "oneShot" },
  FishdogGroup: { experience: "playerHeld", totalItemQuantity: 5, recipient: "FishdogServerAdded" },
  FishdogServerAdded: { experience: "playerHeld", serverAdded: true },
  GlowstickPack: { experience: "playerHeld", totalItemQuantity: 6, recipient: "GlowStickServerAdded" },
  GlowStickServerAdded: { experience: "playerHeld", serverAdded: true },
  StinkyCheeseSingle: { experience: "oneShot" },
  PizzaPlanetGroup: { experience: "playerHeld", totalItemQuantity: 6, recipient: "PizzaPlanetServerAdded" },
  PizzaPlanetServerAdded: { experience: "playerHeld", serverAdded: true },
  ZootopiaPawpsicle: { experience: "oneShot" },
  FindingDoryBubbleWand: { experience: "oneShot" },
  MonstersScareCanister: { experience: "oneShot" },
  FrozenSnowflake: { experience: "oneShot" },
  SuperFirework: { experience: "oneShot" },
  FireHydrant: { experience: "oneShot" },
  SeaweedSmoothieTray: { experience: "playerHeld", totalItemQuantity: 4, recipient: "SeaweedSmoothieServerAdded" },
  SeaweedSmoothieServerAdded: { experience: "playerHeld", serverAdded: true },
  ScavengerHuntGroup: { experience: "partyGameLobby" },
  FishBucketGroup: { experience: "partyGameLobby" },
  FindFourGroup: { experience: "partyGameLobby" },
  SpicyPizzaGroup: { experience: "playerHeld", totalItemQuantity: 6, recipient: "SpicyPizzaServerAdded" },
  SpicyPizzaServerAdded: { experience: "playerHeld", serverAdded: true },
  SpicyPizzaSingle: { experience: "oneShot" },
  HalloweenBasketTray: { experience: "playerHeld", totalItemQuantity: 3, recipient: "HalloweenBasketServerAdded" },
  HalloweenBasketServerAdded: { experience: "playerHeld", serverAdded: true },
  HalloweenBasketOrange: { experience: "oneShot" },
  HalloweenBasketPurple: { experience: "oneShot" },
  HalloweenBasketGreen: { experience: "oneShot" },
  GlowStickRainbowNonMember: { experience: "oneShot" },
  HotChocolateGroupNonMember: { experience: "playerHeld", totalItemQuantity: 6, recipient: "HotChocolateServerAdded" },
  PizzaGroupNonMember: { experience: "playerHeld", totalItemQuantity: 6, recipient: "PizzaServerAdded" },
  SquidStickGroupNonMember: { experience: "playerHeld", totalItemQuantity: 6, recipient: "SquidStickServerAdded" },
  SuperFireworkNonMember: { experience: "oneShot" },
  HolidayPartyBlaster: { experience: "world", timeToLive: 5, actionCount: 0, rewardRadius: 2, totalCoins: 25, minCoins: 1 },
  HolidayFirework: { experience: "oneShot" },
  CandyCaneSingle: { experience: "oneShot" },
  CandyCane: { experience: "playerHeld", totalItemQuantity: 4, recipient: "CandyCaneServerAdded" },
  CandyCaneServerAdded: { experience: "playerHeld", serverAdded: true },
  FluffyCakeSingle: { experience: "oneShot" },
  FluffyCakeTray: { experience: "playerHeld", totalItemQuantity: 6, recipient: "FluffyCakeServerAdded" },
  FluffyCakeServerAdded: { experience: "playerHeld", serverAdded: true },
  RainbowSmoothieSingle: { experience: "oneShot" },
  RainbowSmoothieTray: { experience: "playerHeld", totalItemQuantity: 4, recipient: "RainbowSmoothieServerAdded" },
  RainbowSmoothieServerAdded: { experience: "playerHeld", serverAdded: true },
  Science_BeakerSingle: { experience: "oneShot" },
  HotChocolateSingleNonMember: { experience: "oneShot" },
  BirthdayCakeSingleNonMember: { experience: "oneShot" },
  PizzaSingleNonMember: { experience: "oneShot" },
  FireworkNonMember: { experience: "oneShot" },
  FishdogSingleNonMember: { experience: "oneShot" },
  BirthdayCakeGroupNonMember: { experience: "playerHeld", totalItemQuantity: 6, recipient: "BirthdayCakeServerAdded" },
  PinataNonMember: { experience: "world", timeToLive: 30, actionCount: 5, rewardRadius: 3.5, totalCoins: 50, minCoins: 1 },
  PartyBlasterNonMember: { experience: "world", timeToLive: 5, actionCount: 0, rewardRadius: 2, totalCoins: 25, minCoins: 1 },
  MegaPartyBlasterNonMember: { experience: "world", timeToLive: 5, actionCount: 0, rewardRadius: 3.5, totalCoins: 100, minCoins: 1 },
  FireHydrantNonMember: { experience: "oneShot" },
  Science_BeakerSingle_NonMember: { experience: "oneShot" },
  IceCreamTray: { experience: "playerHeld", totalItemQuantity: 3, recipient: "IceCreamServerAdded" },
  IceCreamServerAdded: { experience: "playerHeld", serverAdded: true },
  IceCreamSingle: { experience: "oneShot" },
  Popscorn: { experience: "oneShot" },
  PopscornServerAdded: { experience: "playerHeld", serverAdded: true },
  PopscornTray: { experience: "playerHeld", totalItemQuantity: 3, recipient: "PopscornServerAdded" },
};
