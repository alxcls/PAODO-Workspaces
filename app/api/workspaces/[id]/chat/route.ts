// Internal chat endpoint used by the browser UI.
// Two modes over one SSE response:
//   - send:   body has a non-empty `message` → start a run for the conversation, then stream it
//   - attach: body has an empty/absent `message` → re-attach to a conversation's in-flight run
// In both modes the run is owned by the run broker (not this request), so closing the tab only
// detaches this viewer — the agent keeps going until it finishes or is explicitly stopped.
import { type NextRequest, NextResponse } from "next/server";
import { requireWorkspace } from "@/lib/api/guards";
import type { AgentEvent } from "@/lib/agent/runner";
import * as conversations from "@/lib/conversations/store";
import * as broker from "@/lib/agent/runBroker";
import { SSE_HEADERS, startKeepalive } from "@/lib/agent/sse";
import { createLogger } from "@/lib/infra/logger";
import { startWorkspaceRun } from "@/lib/operations/agent/run";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const log = createLogger("api").child({ workspaceId: id, route: "chat" });
  const ws = requireWorkspace(id);
  if (ws instanceof NextResponse) return ws;

  const body = (await req.json()) as { message?: string; conversationId?: string };
  const conversationId = body.conversationId ?? conversations.getActiveId(ws.id);
  const messages = conversations.getMessages(ws.id, conversationId);
  if (!messages) return new Response("Conversation not found", { status: 404 });

  const userMessage = body.message?.trim();
  if (userMessage) {
    const receipt = startWorkspaceRun(ws.id, {
      prompt: userMessage,
      origin: "chat",
      conversation: { mode: "existing", id: conversationId },
    });
    if (!receipt) return new Response("Workspace not found", { status: 404 });
    if (!receipt.started) return new Response("A run is already in progress", { status: 409 });
    conversations.setActiveId(ws.id, conversationId);
  }

  log.debug({ conversationId, mode: userMessage ? "send" : "attach" }, "chat stream started");
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    start(controller) {
      let closed = false;
      // A run emits nothing between tool_start and tool_result, which can be many minutes. Without
      // this the proxy drops the idle connection and the viewer sees a failure for a run that is
      // still going fine. See lib/agent/sse.ts.
      const stopKeepalive = startKeepalive(controller, encoder);
      const send = (event: AgentEvent) => {
        if (closed) return;
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      };
      const close = () => {
        if (closed) return;
        closed = true;
        stopKeepalive();
        sub?.unsubscribe();
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };

      // Live events arrive here; 'done' ends the stream for this viewer.
      const sub = broker.subscribe(ws.id, conversationId, (event) => {
        send(event);
        if (event.type === "done") close();
      });

      if (!sub) {
        // The run finished (or never existed) between the client's load and this attach. Nothing to
        // stream — the client already holds the persisted history.
        send({ type: "done" });
        close();
        return;
      }

      // Catch a late subscriber up, then live events flow via the callback above.
      for (const event of sub.replay) send(event);
      if (sub.status === "done") close();

      // Tab closed / navigated away: detach this viewer only. The run continues.
      req.signal.addEventListener("abort", close);
    },
  });

  return new Response(stream, { headers: SSE_HEADERS });
}
