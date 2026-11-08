// Chat mutes set by :mute, keyed by account name (any case). In memory:
// they last until they expire or the server restarts.
const mutes = new Map<string, number>();

export function mute(accountName: string, minutes: number): void {
  mutes.set(accountName.toLowerCase(), Date.now() + minutes * 60_000);
}

export function unmute(accountName: string): boolean {
  return mutes.delete(accountName.toLowerCase());
}

/** When the account's mute ends (ms), or undefined if it isn't muted. */
export function mutedUntil(accountName: string | undefined): number | undefined {
  if (!accountName) return undefined;
  const key = accountName.toLowerCase();
  const until = mutes.get(key);
  if (until === undefined) return undefined;
  if (until <= Date.now()) {
    mutes.delete(key);
    return undefined;
  }
  return until;
}
