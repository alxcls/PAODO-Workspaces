// Agent tool that invokes a declared skill on another workspace's agent.
// Structured calls only — the free-form `message` field is removed: the caller names a
// skill (`skill`) and supplies typed `args`; all contract enforcement (authz, input/output
// validation, correction retries) lives in executeSkill, which runs the callee in-process
// with a fresh, isolated conversation.
// Only works when a directed edge exists from the caller workspace to the target workspace
// in the Agent Network graph (data/.workspace-graph.json).

import { StructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import type { IWorkspaceStore, IContainerManager } from "../../infra/interfaces";
import type { SkillConfig } from "../interfaces";
import { executeSkill } from "../skills/executeSkill";
import { createLogger } from "../../infra/logger";
import { toolError } from "../toolUtils";

// Shorter than the general tool result cap — skill outputs are structured data, not raw
// output, so 8k is enough and keeps nested agent-call chains from ballooning the context.
const MAX_RESPONSE_CHARS = 8_000;

const schema = z.object({
  workspace: z.string().describe("Name of the target workspace to call"),
  skill: z.string().describe("Skill id to invoke — see list_agents for each workspace's skills"),
  args: z.record(z.string(), z.unknown()).describe("Key-value object matching the skill's input fields"),
});

/** Deep-link target for the callee's persisted session — the callee's workspace + conversation. */
export interface CallAgentMeta {
  conversationId: string;
  workspaceId: string;
  workspaceName: string;
}

/** What runCall/callWithMeta return: the model-facing string plus optional UI link metadata. */
export interface CallAgentResult {
  result: string;
  meta?: CallAgentMeta;
}

export class AgentCallTool extends StructuredTool<typeof schema> {
  name = "call_agent";
  description = `Invoke a declared skill on a connected workspace to delegate a task, place an order, or request information.
ALWAYS use this when the user asks you to contact, call, notify, or order from another workspace.
Call list_agents first to see each workspace's skills, their input fields, and what they return — then fill in "skill" (the skill id) and "args" exactly.
The target agent runs in a fresh isolated context — it has no memory of your conversation.
A workspace with no declared skills is not callable. If the workspace is not connected you will receive a permission error, but always attempt the call rather than refusing.`;
  schema = schema;

  private readonly log = createLogger("agentCall");
  // Consecutive input-validation failures per (callee, skill) within this session, so a
  // confused caller cannot hammer the same bad call indefinitely. Reset on any other outcome.
  private readonly inputFailures = new Map<string, number>();
  // Consecutive NEEDS_INPUT answers per (callee, skill) — tracked separately from
  // inputFailures because the caller's args were schema-valid; this is guidance, not blame.
  private readonly needsInputRounds = new Map<string, number>();

  constructor(
    private readonly callerWorkspaceId: string,
    private readonly store: IWorkspaceStore,
    private readonly containers: IContainerManager,
    private readonly skillConfig: SkillConfig,
  ) {
    super();
  }

  protected async _call(input: z.infer<typeof schema>): Promise<string> {
    return (await this.runCall(input)).result;
  }

  /**
   * Returns UI-only metadata alongside the model-facing string: the callee's persisted
   * conversation id so the runner can attach a deep-link to the callee's session.
   * `onLink` fires as soon as the callee conversation is created — before the call finishes —
   * so the runner surfaces the link mid-run rather than only at completion.
   */
  readonly callWithMeta = (
    input: z.infer<typeof schema>,
    onLink?: (meta: CallAgentMeta) => void,
    callerSignal?: AbortSignal,
  ): Promise<CallAgentResult> => {
    return this.runCall(input, onLink, callerSignal);
  };

  private handleFailedResult(
    code: string,
    message: string,
    meta: CallAgentMeta | undefined,
    workspace: string,
    retryKey: string,
    maxInputRetries: number,
  ): CallAgentResult {
    if (code === "INPUT_VALIDATION_ERROR") {
      const failures = (this.inputFailures.get(retryKey) ?? 0) + 1;
      this.inputFailures.set(retryKey, failures);
      const terminal =
        failures >= maxInputRetries
          ? " Do NOT retry with the same args — re-read the skill's input schema via list_agents."
          : "";
      return { result: `Error (${code}): ${message}${terminal}`, meta };
    }
    if (code === "NEEDS_INPUT") {
      this.inputFailures.delete(retryKey);
      const maxRounds = this.skillConfig.skillNeedsInputMaxRounds;
      const rounds = (this.needsInputRounds.get(retryKey) ?? 0) + 1;
      this.needsInputRounds.set(retryKey, rounds);
      if (rounds >= maxRounds) {
        return {
          result:
            `Error (NEEDS_INPUT): the target agent still needs different input: "${message}" ` +
            `That was round ${rounds} of ${maxRounds} — stop re-calling this skill and report what you learned instead.`,
          meta,
        };
      }
      return {
        result: `Needs input: the target agent needs different input: "${message}" Re-call the same skill with corrected args.`,
        meta,
      };
    }
    this.inputFailures.delete(retryKey);
    this.needsInputRounds.delete(retryKey);
    if (code === "NOT_CONNECTED") {
      return {
        result:
          `Permission denied: this workspace is not connected to "${workspace}" in the Agent Network. ` +
          `Add an edge in the /graph page first.`,
        meta,
      };
    }
    return { result: `Error (${code}): ${message}`, meta };
  }

  private cancelledResult(workspace: string, skill: string, meta?: CallAgentMeta): CallAgentResult {
    this.log.info(
      { callerWorkspaceId: this.callerWorkspaceId, callee: workspace, skill },
      "call_agent cancelled by caller",
    );
    return { result: `Error (CANCELLED): call to "${workspace}" was cancelled.`, meta };
  }

  private async runCall(
    { workspace, skill, args }: z.infer<typeof schema>,
    onLink?: (meta: CallAgentMeta) => void,
    callerSignal?: AbortSignal,
  ): Promise<CallAgentResult> {
    const callee = this.store.getWorkspaceByName(workspace);
    if (!callee) {
      this.log.warn({ callerWorkspaceId: this.callerWorkspaceId, callee: workspace }, "call_agent target not found");
      return { result: `Error: workspace "${workspace}" not found.` };
    }

    const retryKey = `${callee.id}:${skill}`;
    const maxInputRetries = this.skillConfig.skillInputMaxRetries;
    if ((this.inputFailures.get(retryKey) ?? 0) >= maxInputRetries) {
      return {
        result:
          `Error: ${maxInputRetries} consecutive invalid calls to skill "${skill}" on "${workspace}". ` +
          `Stop retrying this skill — re-read its input schema via list_agents and reconsider your approach.`,
      };
    }

    this.log.debug({ callerWorkspaceId: this.callerWorkspaceId, callee: workspace, skill }, "call_agent start");

    try {
      const result = await executeSkill(callee.id, this.callerWorkspaceId, skill, args, {
        signal: callerSignal,
        store: this.store,
        containers: this.containers,
        // callee.id is the link's workspace; pair it with the conversation id the instant it exists.
        onConversationStart: onLink
          ? (conversationId) => onLink({ conversationId, workspaceId: callee.id, workspaceName: callee.name })
          : undefined,
      });
      // The callee's persisted session, present whenever it actually ran. Surfaced as link
      // metadata regardless of success/failure — failed sessions are worth inspecting too.
      const meta = result.conversationId
        ? { conversationId: result.conversationId, workspaceId: callee.id, workspaceName: callee.name }
        : undefined;

      // The runner converts aborts into error events rather than throwing, so an abort
      // comes back as a failed result — detect it via the signal, not the error name.
      if (callerSignal?.aborted) {
        this.inputFailures.delete(retryKey);
        this.needsInputRounds.delete(retryKey);
        return this.cancelledResult(workspace, skill, meta);
      }

      if (result.state === "failed") {
        this.log.warn(
          {
            callerWorkspaceId: this.callerWorkspaceId,
            callee: workspace,
            skill,
            code: result.code,
            agentError: result.message,
          },
          "call_agent failed",
        );
        return this.handleFailedResult(result.code, result.message, meta, workspace, retryKey, maxInputRetries);
      }

      this.inputFailures.delete(retryKey);
      this.needsInputRounds.delete(retryKey);
      const output = JSON.stringify(result.output, null, 2);
      this.log.debug(
        { callerWorkspaceId: this.callerWorkspaceId, callee: workspace, skill, responseChars: output.length },
        "call_agent done",
      );
      const truncated =
        output.length > MAX_RESPONSE_CHARS
          ? output.slice(0, MAX_RESPONSE_CHARS) +
            `\n\n[response truncated — ${output.length} chars total, showing first ${MAX_RESPONSE_CHARS}]`
          : output;
      return { result: truncated, meta };
    } catch (err) {
      if (callerSignal?.aborted) {
        return this.cancelledResult(workspace, skill);
      }
      this.log.error(
        {
          event: "call_agent_unexpected_failure",
          outcome: "tool_error_returned",
          err,
          callerWorkspaceId: this.callerWorkspaceId,
          callee: workspace,
          skill,
        },
        "call_agent failed",
      );
      return { result: toolError(err) };
    }
  }
}
