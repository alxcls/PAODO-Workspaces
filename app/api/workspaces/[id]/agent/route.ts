// Public agent endpoint authenticated via Bearer API key and protected by rate limiting.
// Each call belongs to a persisted workspace conversation and runs through the same broker as the
// UI chat route, so it remains visible, re-attachable, stoppable, and durable in the UI.
export const runtime = "nodejs";

import { type NextRequest, NextResponse } from "next/server";
import { requireWorkspace, rateLimited, subjectRateLimited } from "@/lib/api/guards";
import { validateKey } from "@/lib/infra/security/apiKeyStore";
import { getClientIp } from "@/lib/infra/realtime/clientIp";
import { createLogger } from "@/lib/infra/logger";
import type { AgentEvent } from "@/lib/agent/runner";
import { buildSystemPrompt, buildPromptConfig } from "@/lib/agent/systemPrompt";
import { buildWorkspacePromptInputs } from "@/lib/agent/promptContext";
import { loadAgentConfig } from "@/lib/agent/buildTools";
import { setSystemPrompt } from "@/lib/agent/messageSerialization";
import * as conversations from "@/lib/workspace/conversationStore";
import * as broker from "@/lib/agent/runBroker";

const SSE_HEADERS = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache, no-transform",
  Connection: "keep-alive",
  "X-Accel-Buffering": "no",
} as const;

function apiConversationStream(req: NextRequest, workspaceId: string, conversationId: string): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      let closed = false;
      let response = "";
      let limitReached = false;
      const send = (event: object) => {
        if (!closed) controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      };
      const close = () => {
        if (closed) return;
        closed = true;
        sub?.unsubscribe();
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };
      const handle = (event: AgentEvent) => {
        switch (event.type) {
          case "token":
            response += event.content;
            break;
          case "tool_start":
            send({ type: "tool_start", name: event.name });
            break;
          case "limit_reached":
            limitReached = true;
            break;
          case "error":
            send({ type: "error", message: event.message });
            break;
          case "done":
            send({ type: "response", content: response, iterationLimitReached: limitReached, conversationId });
            send({ type: "done", conversationId });
            close();
            break;
        }
      };

      const sub = broker.subscribe(workspaceId, conversationId, handle);
      if (!sub) {
        // The run completed before this response subscribed. Its conversation was persisted by
        // the broker; callers can use the returned id to fetch or continue it through the UI.
        send({ type: "done", conversationId });
        close();
        return;
      }
      for (const event of sub.replay) handle(event);
      if (sub.status === "done") close();
      // Disconnecting an API caller detaches this SSE viewer; it must not cancel the agent run.
      req.signal.addEventListener("abort", close);
    },
  });
  return new Response(stream, { headers: { ...SSE_HEADERS, "X-Conversation-Id": conversationId } });
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const limited = rateLimited(req, { policy: "publicAgentIp", logContext: { workspaceId: id } });
  if (limited) return limited;

  const plain = req.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
  const log = createLogger("api").child({ workspaceId: id, route: "agent" });

  if (!plain || !validateKey(id, plain)) {
    log.warn({ ip: getClientIp(req) }, "unauthorized request");
    return new Response("Unauthorized", { status: 401 });
  }

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
  const conversationId = body.conversationId ?? conversations.createConversation(ws.id).id;
  const messages = conversations.getMessages(ws.id, conversationId);
  if (!messages) return new Response("Conversation not found", { status: 404 });

  const inputs = buildWorkspacePromptInputs(ws.id, ws.dir);
  setSystemPrompt(messages, buildSystemPrompt(ws.dir, buildPromptConfig(loadAgentConfig(ws.id)), inputs));
  const { alreadyRunning } = broker.startRun({
    workspaceId: ws.id,
    workspaceName: ws.name,
    workspaceDir: ws.dir,
    conversationId,
    messages,
    userInput: body.message.trim(),
    maxIterations: ws.maxIterations,
    origin: "api",
  });
  if (alreadyRunning) return new Response("A run is already in progress", { status: 409 });

  log.info({ conversationId }, "public API chat stream started");
  return apiConversationStream(req, ws.id, conversationId);
}
