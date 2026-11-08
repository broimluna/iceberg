// Counts and amounts that come from the client (URL segments, query
// strings): a whole number from 1 to max, or null.
export function positiveCount(value: unknown, max: number): number | null {
    const n = typeof value === "number" ? value : typeof value === "string" && /^\d+$/.test(value) ? Number(value) : NaN;
    return Number.isSafeInteger(n) && n >= 1 && n <= max ? n : null;
}

// The client shows this error code as "not enough coins".
export const NOT_ENOUGH_COINS = 707;
