// In-memory token-bucket limiter plus the application's central rate-limit policy. The custom
// server applies the global and control-plane layers to every API request; public Bearer endpoints
// and uploads add their narrower route-level policy after that.
import { createLogger } from "../logger";

const log = createLogger("rateLimit");
const LOOPBACK = new Set(["::1", "127.0.0.1", "::ffff:127.0.0.1"]);

export class RateLimiter {
  private store = new Map<string, { tokens: number; updatedAt: number; lastSeen: number }>();
  private checks = 0;

  constructor(
    private windowMs = 60_000,
    private defaultMax = 60,
  ) {}

  check(ip: string, opts?: { max?: number; bucket?: string }): RateLimitResult {
    const max = opts?.max ?? this.defaultMax;
    if (LOOPBACK.has(ip)) return { ok: true, retryAfter: 0, limit: max, remaining: max };
    const key = opts?.bucket ? `${ip}:${opts.bucket}` : ip;
    const now = Date.now();

    // Opportunistic cleanup keeps spoofed/rotating subjects from growing this process-local map
    // forever. Active entries are retained for two complete refill windows.
    if (++this.checks % 256 === 0) {
      for (const [storedKey, stored] of this.store) {
        if (now - stored.lastSeen > this.windowMs * 2) this.store.delete(storedKey);
      }
    }

    const entry = this.store.get(key);
    if (!entry) {
      this.store.set(key, { tokens: max - 1, updatedAt: now, lastSeen: now });
      return { ok: true, retryAfter: 0, limit: max, remaining: max - 1 };
    }

    const refillPerMs = max / this.windowMs;
    entry.tokens = Math.min(max, entry.tokens + (now - entry.updatedAt) * refillPerMs);
    entry.updatedAt = now;
    entry.lastSeen = now;
    if (entry.tokens < 1) {
      const retryAfter = Math.max(1, Math.ceil((1 - entry.tokens) / refillPerMs / 1000));
      log.warn({ ip, bucket: opts?.bucket, retryAfter }, "rate limit exceeded");
      return { ok: false, retryAfter, limit: max, remaining: 0 };
    }
    entry.tokens -= 1;
    return { ok: true, retryAfter: 0, limit: max, remaining: Math.floor(entry.tokens) };
  }
}

export interface RateLimitResult {
  ok: boolean;
  retryAfter: number;
  limit: number;
  remaining: number;
}

export const RATE_LIMIT_POLICIES = {
  // Coarse safety net for every /api request. Feature limits below are intentionally tighter.
  global: { max: 600, bucket: "global" },
  controlRead: { max: 300, bucket: "control:read" },
  controlWrite: { max: 120, bucket: "control:write" },
  destructive: { max: 30, bucket: "control:destructive" },
  uiAgent: { max: 30, bucket: "agent:ui" },
  upload: { max: 200, bucket: "upload" },
  publicAgentIp: { max: 60, bucket: "agent:public:ip" },
  workspaceAgent: { max: 20, bucket: "agent:workspace" },
  publicMcpIp: { max: 120, bucket: "mcp:public:ip" },
  workspaceMcp: { max: 60, bucket: "mcp:workspace" },
} as const;

export type RateLimitPolicy = keyof typeof RATE_LIMIT_POLICIES;

const _limiter = new RateLimiter();

export function checkRateLimit(ip: string, opts?: { max?: number; bucket?: string }): RateLimitResult {
  return _limiter.check(ip, opts);
}

export function checkRateLimitPolicy(subject: string, policy: RateLimitPolicy, scope?: string): RateLimitResult {
  const config = RATE_LIMIT_POLICIES[policy];
  return checkRateLimit(subject, {
    max: config.max,
    bucket: scope ? `${config.bucket}:${scope}` : config.bucket,
  });
}

const PUBLIC_AGENT = /^\/api\/(?:agent|workspaces\/[^/]+\/agent)$/;
const PUBLIC_MCP = /^\/api\/workspaces\/[^/]+\/mcp$/;
const UPLOAD = /^\/api\/(?:workspaces|drives)\/[^/]+\/files\/upload$/;
const UI_CHAT = /^\/api\/workspaces\/[^/]+\/chat$/;

/** Routes with their own route-level limiter only receive the global layer here. */
export function classifyControlPlanePolicy(method: string, pathname: string): RateLimitPolicy | null {
  if (PUBLIC_AGENT.test(pathname) || PUBLIC_MCP.test(pathname) || UPLOAD.test(pathname)) return null;
  if (UI_CHAT.test(pathname)) return "uiAgent";
  if (method === "GET" || method === "HEAD" || pathname.endsWith("/files/download")) return "controlRead";
  if (method === "DELETE" || pathname.endsWith("/restore")) return "destructive";
  return "controlWrite";
}

export function checkApiRateLimit(
  subject: string,
  method: string,
  pathname: string,
): RateLimitResult & {
  policy: RateLimitPolicy;
} {
  const global = checkRateLimitPolicy(subject, "global");
  if (!global.ok) return { ...global, policy: "global" };

  const policy = classifyControlPlanePolicy(method, pathname);
  if (!policy) return { ...global, policy: "global" };
  return { ...checkRateLimitPolicy(subject, policy), policy };
}
