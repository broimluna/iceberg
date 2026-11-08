// One running party game. Subclasses hold the rules; the manager owns the
// wire, rewards and player bookkeeping.
import type { RegisteredSession } from "../session-registry.ts";
import type { PartyGameDef } from "./definitions.ts";
import { endSession, guarded, sendGameMessage } from "./manager.ts";

// Multiplies every party-game delay (tests run whole matches in moments).
export const TIME_SCALE = (() => {
  const v = Number(process.env.PARTY_GAME_TIME_SCALE);
  return Number.isFinite(v) && v > 0 ? v : 1;
})();

export interface PartyGamePlayer {
  entry: RegisteredSession;
  left: boolean;
}

export abstract class PartyGameSession {
  readonly templateId: number;
  readonly players: PartyGamePlayer[];
  ended = false;
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();

  constructor(readonly id: number, readonly def: PartyGameDef, players: RegisteredSession[]) {
    this.templateId = def.id;
    this.players = players.map((entry) => ({ entry, left: false }));
  }

  // Runs fn after `seconds` (scaled), unless the game has ended by then.
  protected timer(seconds: number, fn: () => void): void {
    const t = setTimeout(() => {
      this.timers.delete(t);
      if (!this.ended) guarded(this, fn);
    }, seconds * 1000 * TIME_SCALE);
    this.timers.add(t);
  }

  clearTimers(): void {
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
  }

  // pgame.message to every player still here. A string body is sent as is.
  protected sendMessage(type: number, body: object | string): void {
    sendGameMessage(this, type, typeof body === "string" ? body : JSON.stringify(body));
  }

  protected endWith(placements: Map<RegisteredSession, number>): void {
    endSession(this, placements);
  }

  abstract onStart(): void;
  abstract onMessage(player: PartyGamePlayer, type: number, message: unknown): void;
  abstract onPlayerLeft(player: PartyGamePlayer): void;
}
