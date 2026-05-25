// Agent tool that delegates a task to another workspace's agent.
// Only works when a directed edge exists from the caller workspace to the target workspace
// in the Agent Network graph (data/workspace-graph.json).
// Runs the callee agent with a fresh, isolated conversation — no shared history.
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { SystemMessage } from "@langchain/core/messages";
import { canCall } from "../../infra/workspaceGraph";
import { getWorkspaceByName, getWorkspace } from "../../infra/workspaceStore";
import { buildSystemPrompt } from "../systemPrompt";
import { createLogger } from "../../infra/logger";
// runner is imported dynamically inside the function to avoid the circular:
// agentCall → runner → buildTools → agentCall

// Shorter than the general tool result cap — agent responses are prose, not raw output,
// so 8k is enough and keeps nested agent-call chains from ballooning the context.
const MAX_RESPONSE_CHARS = 8_000;
const TIMEOUT_MS = 120_000;

export function buildAgentCallTool(callerWorkspaceId: string) {
  const log = createLogger("agentCall");
  return tool(
    async ({ workspace, message }) => {
      const callee = getWorkspaceByName(workspace);
      if (!callee) {
        log.warn({ callerWorkspaceId, callee: workspace }, "call_agent target not found");
        return `Error: workspace "${workspace}" not found.`;
      }

      if (!canCall(callerWorkspaceId, callee.id)) {
        log.warn({ callerWorkspaceId, callee: workspace }, "call_agent permission denied — no edge in graph");
        return (
          `Permission denied: this workspace is not connected to "${workspace}" in the Agent Network. ` +
          `Add an edge in the /graph page first.`
        );
      }

      const freshMessages: SystemMessage[] = [buildSystemPrompt(callee.dir)];
      const caller = getWorkspace(callerWorkspaceId);
      const taggedMessage = caller ? `[From: ${caller.name}] ${message}` : message;

      log.debug({ callerWorkspaceId, callee: workspace }, "call_agent start");

      try {
        const { runAgent } = await import("../runner");
        const signal = AbortSignal.timeout(TIMEOUT_MS);
        let response = "";
        let limitReached = false;

        for await (const event of runAgent(freshMessages, taggedMessage, callee.dir, callee.id, { signal, maxIterations: callee.maxIterations })) {
          if (event.type === "token") response += event.content;
          if (event.type === "limit_reached") limitReached = true;
          if (event.type === "error") {
            log.error({ callerWorkspaceId, callee: workspace, agentError: event.message }, "call_agent remote error");
            return `Error from "${workspace}": ${event.message}`;
          }
        }

        log.debug({ callerWorkspaceId, callee: workspace, responseChars: response.length, limitReached }, "call_agent done");
        if (!response) return `(${workspace} produced no response)`;
        const note = limitReached
          ? `\n\n[Note: "${workspace}" reached its iteration limit — the above is a partial result.]`
          : "";
        const full = response + note;
        return full.length > MAX_RESPONSE_CHARS
          ? full.slice(0, MAX_RESPONSE_CHARS) +
              `\n\n[response truncated — ${full.length} chars total, showing first ${MAX_RESPONSE_CHARS}]`
          : full;
      } catch (err) {
        if (err instanceof Error && err.name === "AbortError") {
          log.warn({ callerWorkspaceId, callee: workspace, timeoutMs: TIMEOUT_MS }, "call_agent timed out");
          return `Error: call to "${workspace}" timed out after ${TIMEOUT_MS / 1000}s — the target agent is too slow or stuck.`;
        }
        log.error({ err, callerWorkspaceId, callee: workspace }, "call_agent failed");
        return `Error: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
    {
      name: "call_agent",
      description: `Contact a connected workspace to delegate a task, place an order, or request information.
ALWAYS use this when the user asks you to contact, call, notify, or order from another workspace.
If you don't know which workspaces are available, call list_agents first.
The target agent runs in a fresh isolated context — it has no memory of your conversation.
If the workspace is not connected you will receive a permission error, but always attempt the call rather than refusing.`,
      schema: z.object({
        workspace: z.string().describe("Name of the target workspace to call"),
        message: z.string().describe("Task or question to send to the target agent"),
      }),
    }
  );
}
