// Content identifier of a room name: clientVersion;contentVersion;date;abTestGroup.
// The date is today's UTC date; the client reads it as the content date.
import config from "../config.ts";

export function todayUtc(now = new Date()): string {
    return now.toISOString().slice(0, 10);
}

export function buildContentIdentifier(clientVersion = config.content.clientVersion, now = new Date()): string {
    const { contentVersion, abTestGroup } = config.content;
    return `${clientVersion};${contentVersion};${todayUtc(now)};${abTestGroup}`;
}
