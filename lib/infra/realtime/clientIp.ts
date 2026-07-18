// Extracts the client IP from a NextRequest. See the sibling in security/httpAuth.ts for why
// cf-connecting-ip is the only forwarded address trusted here: it is the one header the edge
// overwrites, so it cannot be chosen by the caller. There is no socket to fall back to in a route
// handler, so an absent header is reported as unknown rather than guessed at.
export function getClientIp(req: Pick<Request, "headers">): string {
  return req.headers.get("cf-connecting-ip")?.trim() || "unknown";
}
