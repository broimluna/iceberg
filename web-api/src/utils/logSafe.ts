// Client-supplied values written to the log: on one line (control and
// line-separator characters escaped, so a value can't start a forged log
// line or send terminal escapes) and cut to a fixed length.
const MAX_CHARS = 300;

export function logSafe(value: unknown, max = MAX_CHARS): string {
    let text: string;
    if (typeof value === "string") text = value;
    else {
        try { text = JSON.stringify(value) ?? String(value); } catch { text = String(value); }
    }
    const length = text.length;
    if (length > max) text = text.slice(0, max);
    text = text.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, (c) => {
        switch (c) {
            case "\n": return "\\n";
            case "\r": return "\\r";
            case "\t": return "\\t";
            case "\u2028": return "\\u2028";
            case "\u2029": return "\\u2029";
            default: return "\\x" + c.charCodeAt(0).toString(16).padStart(2, "0");
        }
    });
    return length > max ? `${text}...(${length} chars)` : text;
}

// A request URL for the log: the Guest Controller sends refresh tokens in
// the path (/guest/refresh-auth/<token>), which must not reach the log.
export function logUrl(url: unknown): string {
    return logSafe(String(url ?? "").replace(/(\/refresh-auth\/)[^/?#]*/gi, "$1<redacted>"));
}
