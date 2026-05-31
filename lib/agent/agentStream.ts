// Wraps the agent runner in a Server-Sent Events (SSE) Response.
// Translates AgentEvents from runAgent into SSE data frames and closes the stream on completion or error.
import type { Logger } from "pino";
import { buildSystemPrompt } from "./systemPrompt";
import { runAgent } from "./runner";
import type { Workspace } from "../infra/workspaceStore";

const SSE_HEADERS = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache, no-transform",
  Connection: "keep-alive",
  "X-Accel-Buffering": "no",
} as const;

export function makeAgentStream(ws: Workspace, message: string, log: Logger): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: object) =>
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      let response = "";
      let limitReached = false;
      try {
        const isolatedMessages = [buildSystemPrompt(ws.dir)];
        for await (const event of runAgent(isolatedMessages, message, ws.dir, ws.id, { maxIterations: ws.maxIterations })) {
          if (event.type === "token") response += event.content;
          else if (event.type === "tool_start") send({ type: "tool_start", name: event.name });
          else if (event.type === "limit_reached") limitReached = true;
          else if (event.type === "error") send({ type: "error", message: event.message });
          else if (event.type === "done") {
            send({ type: "response", content: response, iterationLimitReached: limitReached });
            send({ type: "done" });
            break;
          }
        }
      } catch (err) {
        log.error({ err }, "agent stream error");
        send({ type: "error", message: String(err) });
        send({ type: "done" });
      } finally {
        controller.close();
      }
    },
  });
  return new Response(stream, { headers: SSE_HEADERS });
}
