// Simple in-memory rate limiter keyed by IP address.
// Allows up to 20 requests per 60-second window and returns a retryAfter value when the limit is exceeded.
const store = new Map<string, { count: number; resetAt: number }>();
const WINDOW_MS = 60_000;
const MAX = 20;

export function checkRateLimit(ip: string): { ok: boolean; retryAfter: number } {
  const now = Date.now();
  const entry = store.get(ip);
  if (!entry || now > entry.resetAt) {
    store.set(ip, { count: 1, resetAt: now + WINDOW_MS });
    return { ok: true, retryAfter: 0 };
  }
  if (entry.count >= MAX) {
    return { ok: false, retryAfter: Math.ceil((entry.resetAt - now) / 1000) };
  }
  entry.count++;
  return { ok: true, retryAfter: 0 };
}
