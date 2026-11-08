// Connections still logging in (MAX_PENDING_LOGINS in config.ts). When the
// pool is full, the oldest connection from the address holding the most
// pending connections gives way, so a flood from a few addresses can't
// push out a real player who is partway through logging in.
export class PendingPool<T> {
  private byAddress = new Map<string, Set<T>>();
  private addressOf = new Map<T, string>();

  constructor(private readonly max: number) {}

  get size(): number {
    return this.addressOf.size;
  }

  /** Adds a connection; returns the one evicted to make room, if any. */
  add(item: T, address: string): T | undefined {
    let set = this.byAddress.get(address);
    if (!set) this.byAddress.set(address, (set = new Set()));
    set.add(item);
    this.addressOf.set(item, address);
    if (!(this.max > 0) || this.addressOf.size <= this.max) return undefined;
    let busiest: Set<T> | undefined;
    for (const s of this.byAddress.values()) if (!busiest || s.size > busiest.size) busiest = s;
    const victim = busiest!.values().next().value as T;
    this.remove(victim);
    return victim;
  }

  remove(item: T): void {
    const address = this.addressOf.get(item);
    if (address === undefined) return;
    this.addressOf.delete(item);
    const set = this.byAddress.get(address)!;
    set.delete(item);
    if (set.size === 0) this.byAddress.delete(address);
  }
}
