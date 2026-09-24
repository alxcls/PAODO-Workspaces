// Public agent endpoint (Bearer API key, rate limited). Each call is a persisted conversation run through
// the same broker as the UI chat, so it stays visible, re-attachable, stoppable, and durable in the UI.
export const runtime = "nodejs";

import { type NextRequest, NextResponse } from "next/server";
import { requireWorkspace, subjectRateLimited } from "@/lib/api/guards";
import { appErrorResponse, readJsonObject } from "@/lib/api/errorResponse";
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

  const parsed = await readJsonObject(req);
  if (parsed instanceof Response) return parsed;
  const body = parsed as { message?: unknown; conversationId?: string };
  if (typeof body.message !== "string" || !body.message.trim()) {
    return new Response("message is required", { status: 400 });
  }

  // New conversation by default, so an automation never appends to the one a human last selected;
  // pass conversationId to continue one deliberately.
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
