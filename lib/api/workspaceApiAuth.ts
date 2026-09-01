// Bearer authentication shared by the public workspace-scoped API routes (agent run and stop), so
// both gate identically: per-IP rate limit, workspace-scoped key validation, and a throttled 401.
// These routes are reachable by anyone on the internet through the public Caddy gateway, so the
// unauthorized log is throttled to bound a flood spread across many sources.
import type { NextRequest } from "next/server";
import { rateLimited } from "@/lib/api/guards";
import { validate } from "@/lib/infra/security/credentialStore";
import { getClientIp } from "@/lib/infra/realtime/clientIp";
import { createAuditLogger } from "@/lib/infra/logger";
import { throttleLogWithSources } from "@/lib/infra/logThrottle";

/** Return a short-circuit Response (429 or 401) when auth fails, or null once the caller is trusted. */
export function authenticateWorkspaceApi(req: NextRequest, id: string, route: string): Response | null {
  const limited = rateLimited(req, { policy: "publicAgentIp", logContext: { workspaceId: id, route } });
  if (limited) return limited;

  const plain = req.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
  if (plain && validate("workspace-api", id, plain)) return null;

  const ip = getClientIp(req);
  const throttled = throttleLogWithSources("api_auth_unauthorized", ip);
  if (throttled) {
    createAuditLogger("api")
      .child({ workspaceId: id, route })
      .warn(
        { ip, requestId: req.headers.get("x-request-id") ?? undefined, event: "api_auth_unauthorized", ...throttled },
        "unauthorized request",
      );
  }
  return new Response("Unauthorized", { status: 401 });
}
