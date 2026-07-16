// Shared preamble helpers for API route handlers.
//
// Before this module, every route hand-copied its own "look up the workspace, return 404 if
// missing" and "check the rate limit, return 429 if exceeded" blocks — with five different 404
// response shapes across the codebase. Routing everything through these helpers gives one error
// contract and one place to change it.
//
// Usage narrows via `instanceof`:
//   const ws = requireWorkspace(id);
//   if (ws instanceof NextResponse) return ws;   // ws is now a Workspace
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { getStore } from "@/lib/infra/services";
import { getDrive, type Drive } from "@/lib/workspace/driveStore";
import type { Workspace } from "@/lib/workspace/workspaceStore";
import {
  checkRateLimit,
  checkRateLimitPolicy,
  type RateLimitPolicy,
  type RateLimitResult,
} from "@/lib/infra/security/rateLimit";
import { getClientIp } from "@/lib/infra/realtime/clientIp";
import { createLogger } from "@/lib/infra/logger";

/** The one and only "not found" body every route returns for a missing resource. */
export function notFound(): NextResponse {
  return NextResponse.json({ error: "not found" }, { status: 404 });
}

/** Resolve a workspace by id, or a standard 404 Response to short-circuit the handler. */
export function requireWorkspace(id: string): Workspace | NextResponse {
  return getStore().getWorkspace(id) ?? notFound();
}

/** Resolve a drive by id, or a standard 404 Response to short-circuit the handler. */
export function requireDrive(id: string): Drive | NextResponse {
  return getDrive(id) ?? notFound();
}

/** Apply a route-level IP policy and return a standard 429 response when it is exhausted. */
function rejection(rl: RateLimitResult, logContext: Record<string, unknown>, subject: string): Response | null {
  if (rl.ok) return null;
  createLogger("api").warn({ ...logContext, subject }, "rate limit exceeded");
  return new Response("Too Many Requests", {
    status: 429,
    headers: {
      "Retry-After": String(rl.retryAfter),
      "RateLimit-Limit": String(rl.limit),
      "RateLimit-Remaining": String(rl.remaining),
    },
  });
}

export function rateLimited(
  req: NextRequest,
  opts?: {
    max?: number;
    bucket?: string;
    policy?: RateLimitPolicy;
    scope?: string;
    logContext?: Record<string, unknown>;
  },
): Response | null {
  const ip = getClientIp(req);
  const rl = opts?.policy
    ? checkRateLimitPolicy(ip, opts.policy, opts.scope)
    : checkRateLimit(ip, { max: opts?.max, bucket: opts?.bucket });
  return rejection(rl, { ...opts?.logContext, policy: opts?.policy }, ip);
}

/** Apply an authenticated workspace/principal quota without retaining the bearer secret. */
export function subjectRateLimited(
  subject: string,
  policy: RateLimitPolicy,
  opts?: { scope?: string; logContext?: Record<string, unknown> },
): Response | null {
  return rejection(checkRateLimitPolicy(subject, policy, opts?.scope), { ...opts?.logContext, policy }, subject);
}
