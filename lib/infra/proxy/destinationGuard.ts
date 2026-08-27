// SSRF guard for the credential proxy. The proxy is the single egress path for every workspace
// container, so it must let containers reach the public internet (pip/npm/apt/git) while refusing
// to relay to internal addresses — host loopback, the Docker gateway, cloud metadata
// (169.254.169.254), and other private ranges. We block by destination *IP class* rather than an
// explicit host allowlist so ordinary package installs keep working.
import * as net from "net";
import * as dns from "dns";

// Parse a dotted-quad IPv4 string into its four octets, or null if it is not a valid IPv4 literal.
function parseIPv4(ip: string): [number, number, number, number] | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  const octets = parts.map((p) => (/^\d{1,3}$/.test(p) ? Number(p) : NaN));
  if (octets.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return null;
  return octets as [number, number, number, number];
}

// True when an IPv4 address is not a globally routable public address (loopback, private, CGNAT,
// link-local/metadata, reserved, broadcast, etc.). Anything not matched here is treated as public.
function isBlockedIPv4(ip: string): boolean {
  const o = parseIPv4(ip);
  if (!o) return true; // unparseable → fail closed
  const [a, b] = o;
  if (a === 0) return true; // 0.0.0.0/8 "this host"
  if (a === 10) return true; // 10.0.0.0/8 private
  if (a === 127) return true; // 127.0.0.0/8 loopback
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local + cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 private
  if (a === 192 && b === 168) return true; // 192.168.0.0/16 private
  if (a === 192 && b === 0 && o[2] === 0) return true; // 192.0.0.0/24 IETF protocol assignments
  if (a === 192 && b === 0 && o[2] === 2) return true; // 192.0.2.0/24 TEST-NET-1
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18.0.0/15 benchmarking
  if (a === 198 && b === 51 && o[2] === 100) return true; // 198.51.100.0/24 TEST-NET-2
  if (a === 203 && b === 0 && o[2] === 113) return true; // 203.0.113.0/24 TEST-NET-3
  if (a >= 224) return true; // 224.0.0.0/4 multicast + 240.0.0.0/4 reserved + 255.255.255.255
  return false;
}

// True when an IPv6 address is not globally routable. Handles the common non-global forms plus
// IPv4-mapped addresses, which are re-checked through the IPv4 path in BOTH the dotted
// (::ffff:1.2.3.4) and all-hex (::ffff:0102:0304) notations — the kernel routes either to the
// embedded IPv4, so missing the hex form would let ::ffff:a9fe:a9fe reach 169.254.169.254.
function isBlockedIPv6(ip: string): boolean {
  const lower = ip.toLowerCase().split("%")[0]; // drop any zone id
  if (lower === "::" || lower === "::1") return true; // unspecified + loopback
  // IPv4-mapped / IPv4-compatible, dotted-quad tail: defer to the v4 rules on the embedded address.
  const mapped = /^::(?:ffff:)?(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(lower);
  if (mapped) return isBlockedIPv4(mapped[1]);
  // Same address in all-hex tail form (::ffff:c0a8:0101, or the fully expanded
  // 0:0:0:0:0:ffff:c0a8:0101). The leading run must be all zeros, so a genuine public address whose
  // 6th group merely happens to be ffff won't match. Reconstruct the IPv4 from the last 32 bits.
  const mappedHex = /^(?:0*:)*:?(?:ffff:)?([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(lower);
  if (mappedHex) {
    const hi = parseInt(mappedHex[1], 16);
    const lo = parseInt(mappedHex[2], 16);
    return isBlockedIPv4(`${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`);
  }
  const first = lower.split(":")[0] ?? "";
  const head = parseInt(first || "0", 16);
  if (Number.isNaN(head)) return true; // unparseable → fail closed
  if ((head & 0xfe00) === 0xfc00) return true; // fc00::/7 unique-local
  if ((head & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((head & 0xff00) === 0xff00) return true; // ff00::/8 multicast
  return false;
}

// True when a destination IP literal must not be relayed. Non-IP input fails closed.
export function isBlockedAddress(ip: string): boolean {
  const kind = net.isIP(ip);
  if (kind === 4) return isBlockedIPv4(ip);
  if (kind === 6) return isBlockedIPv6(ip);
  return true;
}

// Build a `net.LookupFunction` (usable as the `lookup` option of net.connect / http(s).request) that
// resolves a hostname and refuses the connection if the resolved address is blocked. Because the
// same call both resolves and validates, the address that is actually dialed is the one that was
// checked — closing the resolve-then-connect (DNS-rebinding) gap. `localhost` resolves to loopback
// and is therefore blocked; IP literals are returned verbatim by dns.lookup and re-checked here.
export function makeGuardedLookup(isBlocked: (ip: string) => boolean = isBlockedAddress): net.LookupFunction {
  return (hostname, options, callback) => {
    dns.lookup(hostname, options, (err, address, family) => {
      if (err) return callback(err, address, family);
      const blocked = Array.isArray(address) ? address.some((a) => isBlocked(a.address)) : isBlocked(address);
      if (blocked) {
        const e = new Error(`blocked destination: ${hostname}`) as NodeJS.ErrnoException;
        e.code = "EBLOCKED";
        return callback(e, Array.isArray(address) ? [] : "", family);
      }
      callback(null, address, family);
    });
  };
}
