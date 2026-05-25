// Simple in-memory rate limiter keyed by IP address (and optional bucket name).
// Callers can pass a custom bucket key and max to isolate limits per operation type.
import { createLogger } from "./logger";

const log = createLogger("rateLimit");
const store = new Map<string, { count: number; resetAt: number }>();
const WINDOW_MS = 60_000;
const DEFAULT_MAX = 20;

const LOOPBACK = new Set(["::1", "127.0.0.1", "::ffff:127.0.0.1"]);

export function checkRateLimit(
  ip: string,
  opts?: { max?: number; bucket?: string }
): { ok: boolean; retryAfter: number } {
  if (LOOPBACK.has(ip)) return { ok: true, retryAfter: 0 };
  const max = opts?.max ?? DEFAULT_MAX;
  const key = opts?.bucket ? `${ip}:${opts.bucket}` : ip;
  const now = Date.now();
  const entry = store.get(key);
  if (!entry || now > entry.resetAt) {
    store.set(key, { count: 1, resetAt: now + WINDOW_MS });
    return { ok: true, retryAfter: 0 };
  }
  if (entry.count >= max) {
    log.warn({ ip, bucket: opts?.bucket, retryAfter: Math.ceil((entry.resetAt - now) / 1000) }, "rate limit exceeded");
    return { ok: false, retryAfter: Math.ceil((entry.resetAt - now) / 1000) };
  }
  entry.count++;
  return { ok: true, retryAfter: 0 };
}
