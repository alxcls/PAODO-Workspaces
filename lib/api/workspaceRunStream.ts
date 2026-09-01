// HTTP/SSE projection of a broker-owned workspace run. Starting and owning the run is an operation;
// this module only translates its events for public API clients.
import type { NextRequest } from "next/server";
import type { AgentEvent } from "@/lib/agent/runner";
import * as broker from "@/lib/agent/runBroker";
import { SSE_HEADERS, startKeepalive } from "@/lib/agent/sse";

export function apiConversationStream(req: NextRequest, workspaceId: string, conversationId: string): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      let closed = false;
      let response = "";
      let limitReached = false;
      let failure: Extract<AgentEvent, { type: "error" }> | undefined;
      const stopKeepalive = startKeepalive(controller, encoder);
      const send = (event: object) => {
        if (!closed) controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
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
      const handle = (event: AgentEvent) => {
        switch (event.type) {
          case "token":
            response += event.content;
            send({ type: "token", content: event.content });
            break;
          case "reasoning":
            send({ type: "reasoning", content: event.content });
            break;
          case "tool_start":
            send({ type: "tool_start", name: event.name, ...(event.id ? { id: event.id } : {}), args: event.args });
            break;
          case "tool_result":
            // `id` pairs this result with its tool_start; parallel calls to one tool share a `name`.
            send({ type: "tool_result", name: event.name, ...(event.id ? { id: event.id } : {}), result: event.result });
            break;
          case "limit_reached":
            limitReached = true;
            break;
          case "error":
            failure = event;
            send({ type: "error", message: event.message, ...(event.code ? { code: event.code } : {}) });
            break;
          case "done":
            // Kept alongside the streamed `token` frames so non-streaming clients still get the whole
            // answer in one frame; streaming clients accumulate the deltas and can ignore this.
            if (!failure) {
              send({ type: "response", content: response, iterationLimitReached: limitReached, conversationId });
            }
            send({
              type: "done",
              conversationId,
              ...(failure ? { status: "failed", ...(failure.code ? { code: failure.code } : {}) } : {}),
            });
            close();
            break;
        }
      };

      const sub = broker.subscribe(workspaceId, conversationId, handle);
      if (!sub) {
        send({ type: "done", conversationId });
        close();
        return;
      }
      for (const event of sub.replay) handle(event);
      if (sub.status === "done") close();
      req.signal.addEventListener("abort", close);
    },
  });
  return new Response(stream, { headers: { ...SSE_HEADERS, "X-Conversation-Id": conversationId } });
}
