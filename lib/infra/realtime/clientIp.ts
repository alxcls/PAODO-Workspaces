import { isLoopbackAddress } from "@/lib/infra/security/rateLimit";

/**
 * Extracts the client IP from a NextRequest. See the sibling in security/httpAuth.ts for why
 * cf-connecting-ip is the only forwarded address read, and for the hop a deployment must have in
 * front of it. A forwarded loopback address is refused because the limiter exempts loopback: honoured
 * here, a header would waive every route-level limit. There is no socket to fall back to in a route
 * handler, so an absent or refused header is reported as unknown rather than guessed at.
 */
export function getClientIp(req: Pick<Request, "headers">): string {
  const forwarded = req.headers.get("cf-connecting-ip")?.trim();
  if (!forwarded || isLoopbackAddress(forwarded)) return "unknown";
  return forwarded;
}
