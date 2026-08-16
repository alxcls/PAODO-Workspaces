// Cookie header parsing, shared by every credential that can arrive as one: the Basic-mode /ws
// session cookie and the assertion cookie an identity-aware proxy sets.

/** Returns the named cookie's raw value, or undefined when the header is absent or lacks it. */
export function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return undefined;
}
