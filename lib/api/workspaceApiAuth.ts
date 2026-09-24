// Bearer auth shared by the public workspace API routes: per-IP rate limit, workspace-scoped key check,
// and a 401 whose log is throttled because anyone on the internet can reach these routes.
import type { NextRequest } from "next/server";
import { rateLimited } from "@/lib/api/guards";
import { validate } from "@/lib/infra/security/credentialStore";
import { getClientIp } from "@/lib/infra/realtime/clientIp";
import { createAuditLogger } from "@/lib/infra/logger";
import { throttleLogWithSources } from "@/lib/infra/logThrottle";

export type WorkspaceApiRoute = "agent" | "agent-stop";

/** Returns a short-circuit Response (429 or 401) when the caller is rejected, or null once trusted. */
export function guardWorkspaceApi(req: NextRequest, id: string, route: WorkspaceApiRoute): Response | null {
  const limited = rateLimited(req, { policy: "publicAgentIp", logContext: { workspaceId: id, route } });
  if (limited) return limited;
  return requireWorkspaceKey(req, id, route);
}

/** The key check alone, for a route that must rate-limit before it knows the workspace id. */
export function requireWorkspaceKey(req: NextRequest, id: string, route: WorkspaceApiRoute): Response | null {
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
