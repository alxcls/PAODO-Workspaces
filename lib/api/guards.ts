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
import { checkRateLimit } from "@/lib/infra/security/rateLimit";
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

/**
 * Apply the shared per-IP rate limit. Returns a 429 Response to short-circuit the handler, or
 * null when the request may proceed. Logs the rejection at warn level with the client IP and any
 * `logContext` (e.g. `{ workspaceId }` / `{ route }`) the caller wants attributed. Pass the same
 * `opts` the raw `checkRateLimit` call used (e.g. the upload routes' `{ max, bucket }`).
 */
export function rateLimited(
  req: NextRequest,
  opts?: { max?: number; bucket?: string; logContext?: Record<string, unknown> },
): Response | null {
  const ip = getClientIp(req);
  const rl = checkRateLimit(ip, opts);
  if (rl.ok) return null;
  createLogger("api").warn({ ...opts?.logContext, ip }, "rate limit exceeded");
  return new Response("Too Many Requests", {
    status: 429,
    headers: { "Retry-After": String(rl.retryAfter) },
  });
}
