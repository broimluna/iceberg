/**
 * Routes Index
 *
 * Aggregates all route modules for clean importing.
 */

import sessionRoutes from "./session.ts";
import gameRoutes from "./game.ts";
import playerRoutes from "./player.ts";
import questRoutes, { grantQuestObjectiveReward } from "./quest.ts";
import rewardRoutes, { applyRewards } from "./reward.ts";
import inventoryRoutes from "./inventory.ts";
import catalogRoutes from "./catalog.ts";
import taskRoutes from "./task.ts";
import consumableRoutes from "./consumable.ts";
import tutorialRoutes from "./tutorial.ts";
import breadcrumbRoutes from "./breadcrumb.ts";
import iglooRoutes from "./igloo.ts";
import captchaRoutes from "./captcha.ts";
import chatRoutes from "./chat.ts";
import minigameRoutes from "./minigame.ts";
import moderationRoutes from "./moderation.ts";
import disneystoreRoutes from "./disneystore.ts";
import tubeRoutes from "./tube.ts";
import eventRoutes from "./event.ts";
import encryptionRoutes from "./encryption.ts";
import membershipRoutes from "./membership.ts";
import guestcontrollerRoutes from "./guestcontroller.ts";
import mixRoutes from "./mix/index.ts";
import diagnosticsRoutes from "./diagnostics.ts";

export {
    sessionRoutes,
    gameRoutes,
    playerRoutes,
    questRoutes,
    grantQuestObjectiveReward,
    rewardRoutes,
    applyRewards,
    inventoryRoutes,
    catalogRoutes,
    taskRoutes,
    consumableRoutes,
    tutorialRoutes,
    breadcrumbRoutes,
    iglooRoutes,
    captchaRoutes,
    chatRoutes,
    minigameRoutes,
    moderationRoutes,
    disneystoreRoutes,
    tubeRoutes,
    eventRoutes,
    encryptionRoutes,
    membershipRoutes,
    guestcontrollerRoutes,
    mixRoutes,
    diagnosticsRoutes
};
