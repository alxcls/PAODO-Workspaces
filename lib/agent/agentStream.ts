// Wraps the agent runner in a Server-Sent Events (SSE) Response.
// Translates AgentEvents from runAgent into SSE data frames and closes the stream on completion or error.

import type { Logger } from "pino";
import { buildSystemPrompt, buildPromptConfig } from "./systemPrompt";
import { buildWorkspacePromptInputs } from "./promptContext";
import { loadAgentConfig } from "./buildTools";
import { runAgent } from "./runner";
import type { AgentEvent, AgentRuntimeDeps } from "./runner";
import type { Workspace } from "../workspace/workspaceStore";
import { recordRunError, recordTurnUsage } from "../workspace/usageStore";
import type { SessionOrigin } from "../workspace/usageStore";
import { createWorkspaceRunTimeout } from "./runTimeout";

const SSE_HEADERS = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache, no-transform",
  Connection: "keep-alive",
  "X-Accel-Buffering": "no",
} as const;

type SseState = { response: string; limitReached: boolean };
type AgentStreamStatus = "success" | "failed" | "timeout" | "cancelled" | "limit_reached" | "incomplete";

type AgentStreamDeps = AgentRuntimeDeps & {
  signal?: AbortSignal;
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
      return { type: "error", message: event.message, ...(event.code ? { code: event.code } : {}) };
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
      const startedAt = Date.now();
      const send = (event: object) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      const state: SseState = { response: "", limitReached: false };
      const runTimeout = createWorkspaceRunTimeout(ws, [deps.signal]);
      let sentTimeout = false;
      let recordedError = false;
      let terminalEventSeen = false;
      let terminalStatus: AgentStreamStatus = "success";
      const origin = deps.origin ?? "api";
      const workspaceId = deps.workspaceId ?? ws.id;
      log.info(
        {
          event: "agent_run_started",
          outcome: "run_started",
          sessionId,
          workspaceId,
          origin,
          maxIterations: ws.maxIterations,
          maxRunMinutes: ws.maxRunMinutes,
        },
        "agent run started",
      );
      const recordError = (errorMessage: string, code?: string) => {
        if (recordedError) return;
        recordedError = true;
        recordRunError(
          {
            sessionId,
            workspaceId: deps.workspaceId ?? ws.id,
            workspaceName: deps.workspaceName ?? ws.name,
            origin: deps.origin ?? "api",
          },
          { code, message: errorMessage },
          message,
        );
      };
      const sendTimeout = () => {
        if (sentTimeout) return;
        sentTimeout = true;
        terminalEventSeen = true;
        terminalStatus = "timeout";
        log.warn(
          {
            event: "agent_run_timed_out",
            outcome: "run_ended",
            sessionId,
            workspaceId,
            origin,
            maxRunMinutes: ws.maxRunMinutes,
            durationMs: Date.now() - startedAt,
          },
          "agent run timed out",
        );
        recordError(runTimeout.error.message, "TIMEOUT");
        send({ type: "error", code: "TIMEOUT", message: runTimeout.error.message });
        send({ type: "done" });
      };
      try {
        const inputs = buildWorkspacePromptInputs(ws.id, ws.dir);
        const isolatedMessages = [buildSystemPrompt(ws.name, buildPromptConfig(loadAgentConfig(ws.id)), inputs)];
        for await (const event of runAgent(isolatedMessages, message, ws.dir, ws.id, {
          maxIterations: ws.maxIterations,
          ...deps,
          signal: runTimeout.signal,
        })) {
          if (runTimeout.didTimeout() && event.type === "error") continue;
          if (runTimeout.didTimeout() && event.type === "done") {
            sendTimeout();
            break;
          }
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
          if (event.type === "limit_reached") terminalStatus = "limit_reached";
          if (event.type === "error") {
            terminalStatus = event.code === "TIMEOUT" ? "timeout" : event.code === "CANCELLED" ? "cancelled" : "failed";
            recordError(event.message, event.code);
          }
          if (event.type === "done") {
            terminalEventSeen = true;
            send({ type: "response", content: state.response, iterationLimitReached: state.limitReached });
            send({ type: "done" });
            break;
          }
          const payload = toSsePayload(event, state);
          if (payload) send(payload);
        }
      } catch (err) {
        if (runTimeout.didTimeout()) {
          log.warn({ workspaceId: ws.id, maxRunMinutes: ws.maxRunMinutes }, "agent stream timed out");
          sendTimeout();
        } else {
          terminalStatus = "failed";
          log.error(
            { event: "agent_stream_failed", outcome: "stream_closed_with_error", err, workspaceId: ws.id },
            "agent stream error",
          );
          const message = String(err);
          recordError(message);
          send({ type: "error", message });
          send({ type: "done" });
        }
      } finally {
        if (runTimeout.didTimeout()) sendTimeout();
        if (!terminalEventSeen && terminalStatus === "success") terminalStatus = "incomplete";
        runTimeout.dispose();
        controller.close();
        log.info(
          {
            event: "agent_run_completed",
            outcome: "run_ended",
            sessionId,
            workspaceId,
            origin,
            status: terminalStatus,
            durationMs: Date.now() - startedAt,
          },
          "agent run completed",
        );
      }
    },
  });
  return new Response(stream, { headers: SSE_HEADERS });
}
