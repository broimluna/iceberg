import { isIP } from "node:net";

// The key a connection's address counts against for the per-address
// limits (server.ts): IPv4-mapped IPv6 ("::ffff:a.b.c.d") is the IPv4
// address, and IPv6 counts per /64, one host's usual allocation, so a host
// can't dodge the limits by rotating through its addresses.
export function addressKey(address: string | undefined): string {
  if (!address) return "?";
  if (address.startsWith("::ffff:") && address.includes(".")) return address.slice(7);
  if (!address.includes(":")) return address;
  const [head = "", tail = ""] = address.split("::");
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  const groups = address.includes("::") ? [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill("0"), ...right] : left;
  return groups.slice(0, 4).map((g) => g.toLowerCase().replace(/^0+(?=.)/, "")).join(":") + "::/64";
}

/**
 * The client address a reverse proxy reports in an HTTP request's
 * X-Forwarded-For headers: with `hops` proxies in front, the entry that
 * many from the right (each proxy appends the address it received from;
 * entries further left were written by the client). Header lines are split
 * on CRLF only and the name must match exactly. Undefined if the header is
 * missing, too short, or the chosen entry isn't an IP address.
 */
export function forwardedClient(headerText: string, hops: number): string | undefined {
  const entries: string[] = [];
  for (const line of headerText.split("\r\n").slice(1)) {
    const colon = line.indexOf(":");
    if (colon <= 0 || line.slice(0, colon).toLowerCase() !== "x-forwarded-for") continue;
    entries.push(...line.slice(colon + 1).split(",").map((e) => e.trim()).filter(Boolean));
  }
  const chosen = entries.length >= hops ? entries[entries.length - hops] : undefined;
  return chosen !== undefined && isIP(chosen) ? chosen : undefined;
}
