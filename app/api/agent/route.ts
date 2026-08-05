// SSE endpoint that streams agent events to the browser; validates the workspace API key, starts the runner, and keeps the connection alive.
export const runtime = "nodejs";

import { type NextRequest } from "next/server";
import { getStore } from "@/lib/infra/services";
import { validate } from "@/lib/infra/security/credentialStore";
import { getClientIp } from "@/lib/infra/realtime/clientIp";
import { createAuditLogger, createLogger } from "@/lib/infra/logger";
import { rateLimited, subjectRateLimited } from "@/lib/api/guards";
import { startWorkspaceRun } from "@/lib/operations/agent/run";
import { apiConversationStream } from "@/lib/api/workspaceRunStream";

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

  const receipt = startWorkspaceRun(ws.id, {
    prompt: body.message,
    origin: "api",
    conversation: { mode: "create" },
  });
  if (!receipt) return new Response("Workspace not found", { status: 404 });
  if (!receipt.started) return new Response("A run is already in progress", { status: 409 });

  log.debug({ conversationId: receipt.conversationId }, "legacy public API stream started");
  return apiConversationStream(req, ws.id, receipt.conversationId);
}
