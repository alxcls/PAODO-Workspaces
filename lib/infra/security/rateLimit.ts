// Simple in-memory rate limiter keyed by IP address (and optional bucket name).
// Callers can pass a custom bucket key and max to isolate limits per operation type.
import { createLogger } from "../logger";

const log = createLogger("rateLimit");
const LOOPBACK = new Set(["::1", "127.0.0.1", "::ffff:127.0.0.1"]);

export class RateLimiter {
  private store = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private windowMs = 60_000,
    private defaultMax = 20,
  ) {}

  check(ip: string, opts?: { max?: number; bucket?: string }): { ok: boolean; retryAfter: number } {
    if (LOOPBACK.has(ip)) return { ok: true, retryAfter: 0 };
    const max = opts?.max ?? this.defaultMax;
    const key = opts?.bucket ? `${ip}:${opts.bucket}` : ip;
    const now = Date.now();
    const entry = this.store.get(key);
    if (!entry || now > entry.resetAt) {
      this.store.set(key, { count: 1, resetAt: now + this.windowMs });
      return { ok: true, retryAfter: 0 };
    }
    if (entry.count >= max) {
      log.warn({ ip, bucket: opts?.bucket, retryAfter: Math.ceil((entry.resetAt - now) / 1000) }, "rate limit exceeded");
      return { ok: false, retryAfter: Math.ceil((entry.resetAt - now) / 1000) };
    }
    entry.count++;
    return { ok: true, retryAfter: 0 };
  }
}

const _limiter = new RateLimiter();

export function checkRateLimit(
  ip: string,
  opts?: { max?: number; bucket?: string }
): { ok: boolean; retryAfter: number } {
  return _limiter.check(ip, opts);
}
