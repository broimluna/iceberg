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
