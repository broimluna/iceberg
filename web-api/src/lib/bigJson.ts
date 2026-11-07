// JSON that keeps 64-bit integers exact. The Mix SDK uses C# longs: its
// ClientChatMessageId is a random 64-bit value (e.g. 2211020771495972600),
// past Number.MAX_SAFE_INTEGER, and the app matches the server's reply to
// its pending bubble by that exact id. A plain JSON.parse rounds it.
//
// parseJson turns any integer literal that a JS number can't hold exactly
// into a BigInt (the reviver's source text); stringifyJson writes BigInts
// back as bare digits (JSON.rawJSON). Everything else is unchanged.

export function parseJson(text: string): any {
    return JSON.parse(text, (_key, value, context?: { source?: string }) =>
        typeof value === "number" && !Number.isSafeInteger(value) && context?.source && /^-?\d+$/.test(context.source)
            ? BigInt(context.source)
            : value);
}

export function stringifyJson(value: unknown): string {
    return JSON.stringify(value, (_key, v) => (typeof v === "bigint" ? (JSON as any).rawJSON(v.toString()) : v));
}

/** A C# long: a safe integer or a BigInt within the signed 64-bit range. */
export function isLong(v: unknown): v is number | bigint {
    if (typeof v === "number") return Number.isSafeInteger(v);
    return typeof v === "bigint" && v >= -(2n ** 63n) && v < 2n ** 63n;
}
