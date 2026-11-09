// One running party game. Subclasses hold the rules; the manager owns the
// wire, rewards and player bookkeeping.
import type { RegisteredSession } from "../session-registry.ts";
import type { PartyGameDef } from "./definitions.ts";

// Filled in by manager.ts (which imports the games, so this module can't
// import it back).
export const host = {
  end: (_game: PartyGameSession, _placements: Map<RegisteredSession, number>, _unpaid?: Set<RegisteredSession>): void => {},
  guarded: (_game: PartyGameSession, fn: () => void): void => fn(),
  send: (_game: PartyGameSession, _type: number, _message: string): void => {},
  sendTo: (_game: PartyGameSession, _player: RegisteredSession, _type: number, _message: string): void => {},
  release: (_game: PartyGameSession, _player: PartyGamePlayer): void => {},
  // The game prop a player holds ("con" {type: pgame}) and their locomotion
  // state ("loc"), broadcast to the room.
  setProp: (_entry: RegisteredSession, _name: string | undefined): void => {},
  setLocomotion: (_entry: RegisteredSession, _state: number): void => {},
};

// Multiplies every party-game delay (tests run whole matches in moments).
export const TIME_SCALE = (() => {
  const v = Number(process.env.PARTY_GAME_TIME_SCALE);
  return Number.isFinite(v) && v > 0 ? v : 1;
})();

export interface PartyGamePlayer {
  entry: RegisteredSession;
  left: boolean;
  // Sent an empty pgame.end early (see release): out of the game but still listed in its results.
  released?: boolean;
  // Team and slot in pgame.start.v2's player list (0/0 for single-team games).
  teamId: number;
  roleId: number;
}

export interface PartyGameSlot {
  teamId: number;
  roleId: number;
}

export abstract class PartyGameSession {
  readonly templateId: number;
  readonly players: PartyGamePlayer[];
  ended = false;
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();

  constructor(readonly id: number, readonly def: PartyGameDef, players: RegisteredSession[], slots?: PartyGameSlot[]) {
    this.templateId = def.id;
    this.players = players.map((entry, i) => ({ entry, left: false, teamId: slots?.[i]?.teamId ?? 0, roleId: slots?.[i]?.roleId ?? 0 }));
  }

  // Runs fn after `seconds` (scaled), unless the game has ended by then.
  protected timer(seconds: number, fn: () => void): void {
    const t = setTimeout(() => {
      this.timers.delete(t);
      if (!this.ended) host.guarded(this, fn);
    }, seconds * 1000 * TIME_SCALE);
    this.timers.add(t);
  }

  clearTimers(): void {
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
  }

  // pgame.message to every player still here. A string body is sent as is.
  protected sendMessage(type: number, body: object | string): void {
    host.send(this, type, typeof body === "string" ? body : JSON.stringify(body));
  }

  // pgame.message to one player.
  protected sendMessageTo(player: PartyGamePlayer, type: number, body: object | string): void {
    host.sendTo(this, player.entry, type, typeof body === "string" ? body : JSON.stringify(body));
  }

  // Frees one player's client while the game goes on: an empty-results pgame.end to
  // them alone (the client's own teardown, which restores its controls). They stay
  // listed in the final results but get nothing more from the game.
  protected release(player: PartyGamePlayer): void {
    host.release(this, player);
  }

  // `unpaid` players are listed in the results but get no reward.
  protected endWith(placements: Map<RegisteredSession, number>, unpaid?: Set<RegisteredSession>): void {
    host.end(this, placements, unpaid);
  }

  // The prop a player holds while in this game; putting it away is quitting.
  get gameProp(): string | null {
    return this.def.playerProp;
  }

  // The prop one player holds in this game (a game with per-role props
  // overrides this); putting it away is that player's quit.
  gamePropFor(_player: PartyGamePlayer): string | null {
    return this.gameProp;
  }

  abstract onStart(): void;
  // After pgame.end went out (the session is over and its timers are gone).
  onEnded(): void {}
  abstract onMessage(player: PartyGamePlayer, type: number, message: unknown): void;
  // Each `l.a` position the player reports while in the game.
  onPlayerMoved(_player: PartyGamePlayer, _position: [number, number, number]): void {}
  // Each `l.a` action byte (LocomotionAction) the player sends, with the
  // position it carries. Runs before onPlayerMoved for the same packet.
  onAction(_player: PartyGamePlayer, _action: number, _position: [number, number, number]): void {}
  abstract onPlayerLeft(player: PartyGamePlayer): void;
  // The player put the game prop away (the client's quit). They're still in
  // the room and waiting for pgame.end.
  abstract onPlayerQuit(player: PartyGamePlayer): void;
}
