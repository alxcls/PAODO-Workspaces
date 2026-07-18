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
import { createAuditLogger } from "@/lib/infra/logger";
import { throttleLog } from "@/lib/infra/logThrottle";
import { WorkspaceNameError } from "@/lib/workspace/workspaceName";

/** The one and only "not found" body every route returns for a missing resource. */
export function notFound(): NextResponse {
  return NextResponse.json({ error: "not found" }, { status: 404 });
}

/**
 * Map a WorkspaceNameError to its HTTP response — 409 for a name conflict, 400 for a malformed name —
 * or null if `err` is something else the caller should handle itself. Keeps the create/rename routes'
 * error contract (status + machine-readable `code`) in one place.
 */
export function workspaceNameErrorResponse(err: unknown): NextResponse | null {
  if (!(err instanceof WorkspaceNameError)) return null;
  const status = err.code === "WORKSPACE_NAME_CONFLICT" ? 409 : 400;
  return NextResponse.json({ error: err.message, code: err.code }, { status });
}

/** Resolve a workspace by id, or a standard 404 Response to short-circuit the handler. */
export function requireWorkspace(id: string): Workspace | NextResponse {
  return getStore().getWorkspace(id) ?? notFound();
}

/** Resolve a drive by id, or a standard 404 Response to short-circuit the handler. */
export function requireDrive(id: string): Drive | NextResponse {
  return getDrive(id) ?? notFound();
}

const audit = createAuditLogger("api");

/** Apply a route-level IP policy and return a standard 429 response when it is exhausted. */
function rejection(rl: RateLimitResult, logContext: Record<string, unknown>, subject: string): Response | null {
  if (rl.ok) return null;
  // Throttled: a caller that keeps calling after exhausting its limit is rejected here every time.
  const suppressed = throttleLog("rate_limited");
  if (suppressed !== null) {
    audit.warn({ ...logContext, subject, event: "rate_limited", suppressed }, "rate limit exceeded");
  }
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
  return rejection(
    rl,
    { ...opts?.logContext, policy: opts?.policy, requestId: req.headers.get("x-request-id") ?? undefined },
    ip,
  );
}

/** Apply an authenticated workspace/principal quota without retaining the bearer secret. */
export function subjectRateLimited(
  subject: string,
  policy: RateLimitPolicy,
  opts?: { scope?: string; logContext?: Record<string, unknown> },
): Response | null {
  return rejection(checkRateLimitPolicy(subject, policy, opts?.scope), { ...opts?.logContext, policy }, subject);
}
