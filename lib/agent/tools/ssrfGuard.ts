// SSRF guard for the http_get agent tool. This is the network counterpart to
// the path-containment guard in pathUtils.ts: it stops the agent from reaching
// internal/private addresses (loopback, RFC1918, link-local, cloud metadata at
// 169.254.169.254, CGNAT, etc.) whether the address is given literally or hides
// behind a hostname that resolves to a private IP. Every http_get call routes
// through assertPublicUrl, so this is the chokepoint — keep it pure and tested.
import { lookup } from "node:dns/promises";
import { isIPv4, isIPv6 } from "node:net";

// Resolver shape compatible with node:dns/promises `lookup`. Injectable so the
// hostname-resolution path can be tested without real DNS.
export type HostnameResolver = (hostname: string) => Promise<{ address: string }>;

export function isPrivateIPv4(ip: string): boolean {
  const parts = ip.split(".").map(Number);
  const [a, b] = parts;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168)
  );
}

export function isPrivateIPv6(ip: string): boolean {
  const lower = ip.toLowerCase();
  return (
    lower === "::" ||
    lower === "::1" ||
    lower.startsWith("fc") ||
    lower.startsWith("fd") ||
    lower.startsWith("fe80") ||
    lower.startsWith("::ffff:")
  );
}

export function isPrivateIP(ip: string): boolean {
  if (isIPv4(ip)) return isPrivateIPv4(ip);
  if (isIPv6(ip)) return isPrivateIPv6(ip);
  // Not a parseable IP literal — treat as unsafe rather than letting it through.
  return true;
}

// Validates that rawUrl points at a public HTTPS endpoint and returns the
// final (https-upgraded) URL. Throws on any URL the agent must not reach.
//
// NOTE (DNS-rebinding TOCTOU): when given a hostname we resolve it once here and
// validate that IP, but the subsequent fetch() resolves independently — a
// hostile resolver could return a public IP here and a private one to fetch.
// This guard does not close that window; it blocks the common cases.
export async function assertPublicUrl(
  rawUrl: string,
  resolve: HostnameResolver = lookup,
): Promise<string> {
  const finalUrl = rawUrl.startsWith("http://") ? rawUrl.replace("http://", "https://") : rawUrl;
  let parsed: URL;
  try {
    parsed = new URL(finalUrl);
  } catch {
    throw new Error("Invalid URL");
  }
  if (parsed.protocol !== "https:") throw new Error("Only HTTPS URLs are allowed");

  // WHATWG URL keeps brackets on IPv6 hostnames (e.g. [::1]) — strip both ends.
  // The /g flag matters: without it only the leading "[" is removed, leaving
  // "::1]" which fails isIPv6() and skips the literal check entirely.
  const hostname = parsed.hostname.replace(/^\[|\]$/g, "");

  if (isIPv4(hostname) || isIPv6(hostname)) {
    if (isPrivateIP(hostname)) throw new Error("Blocked internal address");
    return finalUrl;
  }

  // Resolve hostname → IP so alternate encodings (decimal, hex) and IPv6 are caught
  let resolvedIp: string;
  try {
    ({ address: resolvedIp } = await resolve(hostname));
  } catch {
    throw new Error("Failed to resolve hostname");
  }
  if (isPrivateIP(resolvedIp)) throw new Error("Blocked internal address");

  return finalUrl;
}
