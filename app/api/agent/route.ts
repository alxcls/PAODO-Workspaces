// SSE endpoint that streams agent events to the browser; validates the workspace API key, starts the runner, and keeps the connection alive.
export const runtime = "nodejs";

import { type NextRequest } from "next/server";
import { getStore } from "@/lib/infra/services";
import { createLogger } from "@/lib/infra/logger";
import { rateLimited, subjectRateLimited } from "@/lib/api/guards";
import { requireWorkspaceKey } from "@/lib/api/workspaceApiAuth";
import { startWorkspaceRun } from "@/lib/operations/agent/run";
import { apiConversationStream } from "@/lib/api/workspaceRunStream";
import { appErrorResponse, readJsonObject } from "@/lib/api/errorResponse";

export async function POST(req: NextRequest) {
  const log = createLogger("api").child({ route: "agent" });
  const limited = rateLimited(req, { policy: "publicAgentIp", logContext: { route: "agent" } });
  if (limited) return limited;

  const parsed = await readJsonObject(req);
  if (parsed instanceof Response) return parsed;
  const { workspace, message } = parsed as { workspace?: unknown; message?: unknown };
  if (typeof workspace !== "string" || !workspace.trim()) return new Response("workspace is required", { status: 400 });
  if (typeof message !== "string" || !message.trim()) return new Response("message is required", { status: 400 });

  const ws = getStore().getWorkspaceByName(workspace.trim());
  if (!ws) return new Response("Workspace not found", { status: 404 });

  // The id comes from the body, so the shared guard's rate limit already ran above.
  const denied = requireWorkspaceKey(req, ws.id, "agent");
  if (denied) return denied;

  const workspaceLimited = subjectRateLimited(`workspace:${ws.id}`, "workspaceAgent", {
    logContext: { workspaceId: ws.id, route: "agent" },
  });
  if (workspaceLimited) return workspaceLimited;

  let receipt;
  try {
    receipt = startWorkspaceRun(ws.id, {
      prompt: message,
      origin: "api",
      conversation: { mode: "create" },
    });
  } catch (err) {
    const expected = appErrorResponse(err, req);
    if (expected) return expected;
    throw err;
  }
  if (!receipt) return new Response("Workspace not found", { status: 404 });
  if (!receipt.started) return new Response("A run is already in progress", { status: 409 });

  log.debug({ conversationId: receipt.conversationId }, "legacy public API stream started");
  return apiConversationStream(req, ws.id, receipt.conversationId);
}
