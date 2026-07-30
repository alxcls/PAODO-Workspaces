// SSE endpoint that streams agent events to the browser; validates the workspace API key, starts the runner, and keeps the connection alive.
export const runtime = "nodejs";

import { type NextRequest } from "next/server";
import { getStore, getContainers } from "@/lib/infra/services";
import { validate } from "@/lib/infra/security/credentialStore";
import { getClientIp } from "@/lib/infra/realtime/clientIp";
import { createAuditLogger, createLogger } from "@/lib/infra/logger";
import { makeAgentStream } from "@/lib/agent/agentStream";
import { rateLimited, subjectRateLimited } from "@/lib/api/guards";

export async function POST(req: NextRequest) {
  const log = createLogger("api").child({ route: "agent" });
  const audit = createAuditLogger("api").child({ route: "agent" });
  const ip = getClientIp(req);
  const limited = rateLimited(req, { policy: "publicAgentIp", logContext: { route: "agent" } });
  if (limited) return limited;

  const plain = req.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
  const body = (await req.json()) as { workspace?: string; message?: string };

  if (!body.workspace?.trim()) return new Response("workspace is required", { status: 400 });
  if (!body.message?.trim()) return new Response("message is required", { status: 400 });

  const ws = getStore().getWorkspaceByName(body.workspace.trim());
  if (!ws) return new Response("Workspace not found", { status: 404 });

  if (!plain || !validate("workspace-api", ws.id, plain)) {
    audit.warn(
      {
        ip,
        workspace: body.workspace,
        requestId: req.headers.get("x-request-id") ?? undefined,
        event: "api_auth_unauthorized",
      },
      "unauthorized request",
    );
    return new Response("Unauthorized", { status: 401 });
  }

  const workspaceLimited = subjectRateLimited(`workspace:${ws.id}`, "workspaceAgent", {
    logContext: { workspaceId: ws.id, route: "agent" },
  });
  if (workspaceLimited) return workspaceLimited;

  return makeAgentStream(ws, body.message!.trim(), log, {
    store: getStore(),
    containers: getContainers(),
    origin: "api",
  });
}
