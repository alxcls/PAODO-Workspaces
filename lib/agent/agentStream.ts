// Wraps the agent runner in a Server-Sent Events (SSE) Response.
// Translates AgentEvents from runAgent into SSE data frames and closes the stream on completion or error.

import type { Logger } from "pino";
import { buildSystemPrompt, buildPromptConfig } from "./systemPrompt";
import { buildWorkspacePromptInputs } from "./promptContext";
import { loadAgentConfig } from "./buildTools";
import { runAgent } from "./runner";
import type { AgentEvent, AgentRuntimeDeps } from "./runner";
import type { Workspace } from "../workspace/workspaceStore";
import { recordTurnUsage } from "../workspace/usageStore";
import type { SessionOrigin } from "../workspace/usageStore";

const SSE_HEADERS = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache, no-transform",
  Connection: "keep-alive",
  "X-Accel-Buffering": "no",
} as const;

type SseState = { response: string; limitReached: boolean };

type AgentStreamDeps = AgentRuntimeDeps & {
  sessionId?: string;
  workspaceId?: string;
  workspaceName?: string;
  origin?: SessionOrigin;
};

// Maps an AgentEvent to an SSE payload object, or null if the event only updates state.
// Keeps wire-format decisions out of the stream lifecycle.
function toSsePayload(event: AgentEvent, state: SseState): object | null {
  switch (event.type) {
    case "token":
      state.response += event.content;
      return null;
    case "tool_start":
      return { type: "tool_start", name: event.name };
    case "limit_reached":
      state.limitReached = true;
      return null;
    case "error":
      return { type: "error", message: event.message };
    case "turn_usage":
      return null;
    default:
      return null;
  }
}

export function makeAgentStream(ws: Workspace, message: string, log: Logger, deps: AgentStreamDeps = {}): Response {
  // The legacy /api/agent endpoint has no persisted conversation but must still be visible in
  // usage. Allocate its run identity here; callers can override it for tests or integrations.
  const sessionId = deps.sessionId ?? crypto.randomUUID();
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: object) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      const state: SseState = { response: "", limitReached: false };
      try {
        const inputs = buildWorkspacePromptInputs(ws.id, ws.dir);
        const isolatedMessages = [buildSystemPrompt(ws.dir, buildPromptConfig(loadAgentConfig(ws.id)), inputs)];
        for await (const event of runAgent(isolatedMessages, message, ws.dir, ws.id, {
          maxIterations: ws.maxIterations,
          ...deps,
        })) {
          if (event.type === "turn_usage") {
            recordTurnUsage(
              {
                sessionId,
                workspaceId: deps.workspaceId ?? ws.id,
                workspaceName: deps.workspaceName ?? ws.name,
                origin: deps.origin ?? "api",
              },
              event,
            );
            continue;
          }
          if (event.type === "done") {
            send({ type: "response", content: state.response, iterationLimitReached: state.limitReached });
            send({ type: "done" });
            break;
          }
          const payload = toSsePayload(event, state);
          if (payload) send(payload);
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
