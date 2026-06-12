// Agent tool that invokes a declared skill on another workspace's agent.
// Structured calls only — the free-form `message` field is removed: the caller names a
// skill (`action`) and supplies typed `args`; all contract enforcement (authz, input/output
// validation, correction retries) lives in executeSkill, which runs the callee in-process
// with a fresh, isolated conversation.
// Only works when a directed edge exists from the caller workspace to the target workspace
// in the Agent Network graph (data/.workspace-graph.json).
import { StructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import type { IWorkspaceStore, IContainerManager } from "../../infra/interfaces";
import { executeSkill } from "../skills/executeSkill";
import { loadAgentConfig } from ".";
import { createLogger } from "../../infra/logger";

// Shorter than the general tool result cap — skill outputs are structured data, not raw
// output, so 8k is enough and keeps nested agent-call chains from ballooning the context.
const MAX_RESPONSE_CHARS = 8_000;
const TIMEOUT_MS = 300_000;

const schema = z.object({
  workspace: z.string().describe("Name of the target workspace to call"),
  action: z.string().describe("Skill id to invoke — see list_agents for each workspace's skills"),
  args: z.record(z.string(), z.unknown()).describe("Key-value object matching the skill's input fields"),
});

export class AgentCallTool extends StructuredTool<typeof schema> {
  name = "call_agent";
  description = `Invoke a declared skill on a connected workspace to delegate a task, place an order, or request information.
ALWAYS use this when the user asks you to contact, call, notify, or order from another workspace.
Call list_agents first to see each workspace's skills, their input fields, and what they return — then fill in "action" (the skill id) and "args" exactly.
The target agent runs in a fresh isolated context — it has no memory of your conversation.
A workspace with no declared skills is not callable. If the workspace is not connected you will receive a permission error, but always attempt the call rather than refusing.`;
  schema = schema;

  private readonly log = createLogger("agentCall");
  // Consecutive input-validation failures per (callee, skill) within this session, so a
  // confused caller cannot hammer the same bad call indefinitely. Reset on any other outcome.
  private readonly inputFailures = new Map<string, number>();

  constructor(
    private readonly callerWorkspaceId: string,
    private readonly store: IWorkspaceStore,
    private readonly containers: IContainerManager,
  ) {
    super();
  }

  protected async _call({ workspace, action, args }: z.infer<typeof schema>): Promise<string> {
    const callee = this.store.getWorkspaceByName(workspace);
    if (!callee) {
      this.log.warn({ callerWorkspaceId: this.callerWorkspaceId, callee: workspace }, "call_agent target not found");
      return `Error: workspace "${workspace}" not found.`;
    }

    const retryKey = `${callee.id}:${action}`;
    const maxInputRetries = loadAgentConfig().skillInputMaxRetries;
    if ((this.inputFailures.get(retryKey) ?? 0) >= maxInputRetries) {
      return (
        `Error: ${maxInputRetries} consecutive invalid calls to skill "${action}" on "${workspace}". ` +
        `Stop retrying this skill — re-read its input schema via list_agents and reconsider your approach.`
      );
    }

    this.log.debug({ callerWorkspaceId: this.callerWorkspaceId, callee: workspace, action }, "call_agent start");

    const signal = AbortSignal.timeout(TIMEOUT_MS);
    try {
      const result = await executeSkill(callee.id, this.callerWorkspaceId, action, args, {
        signal,
        store: this.store,
        containers: this.containers,
      });

      // The runner converts aborts into error events rather than throwing, so a timeout
      // comes back as a failed result — detect it via the signal, not the error name.
      if (signal.aborted) {
        this.log.warn({ callerWorkspaceId: this.callerWorkspaceId, callee: workspace, action, timeoutMs: TIMEOUT_MS }, "call_agent timed out");
        this.inputFailures.delete(retryKey);
        return `Error: call to "${workspace}" timed out after ${TIMEOUT_MS / 1000}s — the target agent is too slow or stuck.`;
      }

      if (result.state === "failed") {
        this.log.warn({ callerWorkspaceId: this.callerWorkspaceId, callee: workspace, action, code: result.code, agentError: result.message }, "call_agent failed");
        if (result.code === "INPUT_VALIDATION_ERROR") {
          const failures = (this.inputFailures.get(retryKey) ?? 0) + 1;
          this.inputFailures.set(retryKey, failures);
          const terminal = failures >= maxInputRetries
            ? " Do NOT retry with the same args — re-read the skill's input schema via list_agents."
            : "";
          return `Error (${result.code}): ${result.message}${terminal}`;
        }
        this.inputFailures.delete(retryKey);
        if (result.code === "NOT_CONNECTED") {
          return (
            `Permission denied: this workspace is not connected to "${workspace}" in the Agent Network. ` +
            `Add an edge in the /graph page first.`
          );
        }
        return `Error (${result.code}): ${result.message}`;
      }

      this.inputFailures.delete(retryKey);
      const output = JSON.stringify(result.output, null, 2);
      this.log.debug({ callerWorkspaceId: this.callerWorkspaceId, callee: workspace, action, responseChars: output.length }, "call_agent done");
      return output.length > MAX_RESPONSE_CHARS
        ? output.slice(0, MAX_RESPONSE_CHARS) +
            `\n\n[response truncated — ${output.length} chars total, showing first ${MAX_RESPONSE_CHARS}]`
        : output;
    } catch (err) {
      if (signal.aborted) {
        this.log.warn({ callerWorkspaceId: this.callerWorkspaceId, callee: workspace, action, timeoutMs: TIMEOUT_MS }, "call_agent timed out");
        return `Error: call to "${workspace}" timed out after ${TIMEOUT_MS / 1000}s — the target agent is too slow or stuck.`;
      }
      this.log.error({ err, callerWorkspaceId: this.callerWorkspaceId, callee: workspace, action }, "call_agent failed");
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
}
