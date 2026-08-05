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
import { getDrive, type Drive } from "@/lib/drives/store";
import type { Workspace } from "@/lib/workspace/types";
import {
  checkRateLimit,
  checkRateLimitPolicy,
  type RateLimitPolicy,
  type RateLimitResult,
} from "@/lib/infra/security/rateLimit";
import { getClientIp } from "@/lib/infra/realtime/clientIp";
import { createAuditLogger } from "@/lib/infra/logger";
import { throttleLog } from "@/lib/infra/logThrottle";
import { errorResponse } from "@/lib/api/errorResponse";

/** The one and only "not found" body every route returns for a missing resource. */
export function notFound(request?: Request): NextResponse {
  return errorResponse("NOT_FOUND", "not found", { request });
}

const CANONICAL_WORKSPACE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Validate the public workspace-id wire format. Workspace ids are generated as lowercase UUIDs and
 * stored as opaque, case-sensitive keys; accepting another spelling here only turns a malformed
 * request into a misleading not-found response. Kept at the API boundary so UI, CLI and direct HTTP
 * callers receive the same answer.
 */
export function workspaceIdParam(id: string, request?: Request): string | NextResponse {
  if (CANONICAL_WORKSPACE_ID.test(id)) return id;
  return errorResponse("INVALID_REQUEST", "workspace id must be a lowercase UUID", {
    request,
    details: { field: "workspaceId" },
  });
}

/** Validate and resolve a public workspace id, or return the shared 400/404 response. */
export function requireWorkspaceId(id: string, request?: Request): Workspace | NextResponse {
  const canonical = workspaceIdParam(id, request);
  if (canonical instanceof NextResponse) return canonical;
  return getStore().getWorkspace(canonical) ?? notFound(request);
}

/** Resolve a workspace by id, or a standard 404 Response to short-circuit the handler. */
export function requireWorkspace(id: string, request?: Request): Workspace | NextResponse {
  return getStore().getWorkspace(id) ?? notFound(request);
}

/** Resolve a drive by id, or a standard 404 Response to short-circuit the handler. */
export function requireDrive(id: string, request?: Request): Drive | NextResponse {
  return getDrive(id) ?? notFound(request);
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
  return errorResponse("RATE_LIMITED", "Too Many Requests", {
    requestId: typeof logContext.requestId === "string" ? logContext.requestId : undefined,
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
