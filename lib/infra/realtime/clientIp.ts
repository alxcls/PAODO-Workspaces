// Extracts the real client IP from request headers, preferring x-real-ip then the last x-forwarded-for entry (set by Tailscale Serve).
export function getClientIp(req: Pick<Request, "headers">): string {
  return (
    req.headers.get("x-real-ip")?.trim() ?? req.headers.get("x-forwarded-for")?.split(",").at(-1)?.trim() ?? "unknown"
  );
}
