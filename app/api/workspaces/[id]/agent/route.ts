// Public agent endpoint authenticated via Bearer API key and protected by rate limiting.
// Each call belongs to a persisted workspace conversation and runs through the same broker as the
// UI chat route, so it remains visible, re-attachable, stoppable, and durable in the UI.
export const runtime = "nodejs";

import { type NextRequest, NextResponse } from "next/server";
import { requireWorkspace, subjectRateLimited } from "@/lib/api/guards";
import { appErrorResponse } from "@/lib/api/errorResponse";
import { guardWorkspaceApi } from "@/lib/api/workspaceApiAuth";
import { createLogger } from "@/lib/infra/logger";
import { apiConversationStream } from "@/lib/api/workspaceRunStream";
import { ConversationNotFoundError } from "@/lib/operations/agent/errors";
import { startWorkspaceRun } from "@/lib/operations/agent/run";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const denied = guardWorkspaceApi(req, id, "agent");
  if (denied) return denied;

  const log = createLogger("api").child({ workspaceId: id, route: "agent" });

  const workspaceLimited = subjectRateLimited(`workspace:${id}`, "workspaceAgent", {
    logContext: { workspaceId: id, route: "agent" },
  });
  if (workspaceLimited) return workspaceLimited;

  const ws = requireWorkspace(id);
  if (ws instanceof NextResponse) return ws;

  const body = (await req.json()) as { message?: string; conversationId?: string };
  if (!body.message?.trim()) return new Response("message is required", { status: 400 });

  // API calls start independent conversations by default so an automation cannot unexpectedly
  // append to whichever conversation a human last selected in the UI. Pass conversationId to
  // continue a previous API/UI conversation deliberately.
  let receipt;
  try {
    receipt = startWorkspaceRun(ws.id, {
      prompt: body.message,
      origin: "api",
      conversation: body.conversationId ? { mode: "existing", id: body.conversationId } : { mode: "create" },
    });
  } catch (err) {
    if (err instanceof ConversationNotFoundError) return appErrorResponse(err, req)!;
    const expected = appErrorResponse(err, req);
    if (expected) return expected;
    throw err;
  }
  if (!receipt) return new Response("Workspace not found", { status: 404 });
  if (!receipt.started) return new Response("A run is already in progress", { status: 409 });

  const { conversationId } = receipt;

  log.debug({ conversationId }, "public API chat stream started");
  return apiConversationStream(req, ws.id, conversationId);
}
