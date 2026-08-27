// Structured agent-to-agent calls: one function enforcing both sides of a skill contract and running
// the callee between them. Same Node process — an ordinary call, no HTTP, no serialization.
import Ajv, { type ErrorObject, type ValidateFunction } from "ajv";
import { AIMessage, HumanMessage, type BaseMessage } from "@langchain/core/messages";
import { canCall } from "@/lib/agent/graph";
import { TERMINAL_PROVIDER_CODES } from "../providerFailure";
import { loadSkills } from "@/lib/skills/store";
import { createConversation, getMessages, persist } from "@/lib/conversations/store";
import { refreshWorkspaceSystemPrompt } from "../workspacePrompt";
import { appendUsage, recordRunError, recordTurnUsage } from "@/lib/usage/record";
import type { SessionOrigin } from "@/lib/usage/types";
import {
  NEEDS_INPUT_KEY,
  type SkillCallResult,
  type SkillErrorCode,
  type SkillDefinition,
  type SkillSchema,
} from "@/lib/skills/types";
import type { IWorkspaceLookup, IContainerManager } from "../../infra/interfaces";
import { buildStructuredResponderBlock } from "../systemPrompt";
import { noteRunError } from "../messageSerialization";
import { createLogger } from "../../infra/logger";
import type { runAgent, AgentEvent } from "../runner";
import { createWorkspaceRunTimeout, USER_STOPPED_CONVERSATION_MESSAGE, WorkspaceRunTimeoutError } from "../runTimeout";
import { ExecutionCapacityReachedError, type ExecutionCapacityGate } from "../executionCapacity";
import { contentToParagraphs } from "@/lib/transcript/content";
// runner and runBroker are imported dynamically inside executeSkill, to break the cycle:
// tools/index → AgentCallTool → executeSkill → runner → buildTools → tools/index

const log = createLogger("executeSkill");

export interface ExecuteSkillOptions {
  signal?: AbortSignal;
  /** Provenance for the callee's usage session. Direct agent calls default to `agent`. */
  origin?: SessionOrigin;
  store?: IWorkspaceLookup;
  containers?: IContainerManager;
  /** Test seams — production uses the real graph, skill store, runner, and conversation store. */
  canCallFn?: typeof canCall;
  loadSkillsFn?: typeof loadSkills;
  /** A skill already resolved by a trusted discovery boundary (for example MCP). */
  resolvedSkill?: SkillDefinition;
  runAgentFn?: typeof runAgent;
  appendUsageFn?: typeof appendUsage;
  recordRunErrorFn?: typeof recordRunError;
  createConversationFn?: typeof createConversation;
  getMessagesFn?: typeof getMessages;
  persistFn?: typeof persist;
  /** Test seam; production uses the process-wide execution ceiling. */
  capacity?: ExecutionCapacityGate;
  /** Fired the instant the callee's conversation is created (before the run finishes), so the
   *  caller's UI can show the session deep-link mid-call. createConversation already writes the
   *  conversation to SQLite, so the link resolves immediately. */
  onConversationStart?: (conversationId: string) => void;
  outputMaxRetries?: number;
}

function formatAjvErrors(errors: ErrorObject[] | null | undefined): string {
  if (!errors?.length) return "does not match the schema";
  return errors
    .map((e) => {
      const parent = e.instancePath.replace(/^\//, "").replace(/\//g, ".");
      if (e.keyword === "required") {
        const missing = (e.params as { missingProperty: string }).missingProperty;
        const field = parent ? `${parent}.${missing}` : missing;
        return `field '${field}' is required`;
      }
      if (e.keyword === "enum") {
        const allowed = (e.params as { allowedValues: unknown[] }).allowedValues
          .map((value) => JSON.stringify(value))
          .join(", ");
        return parent ? `field '${parent}' must be one of: ${allowed}` : `value must be one of: ${allowed}`;
      }
      const field = parent;
      return field ? `field '${field}' ${e.message}` : `value ${e.message}`;
    })
    .join("; ");
}

// strict:false tolerates loosely-written user schemas (skills are authored by humans in the
// UI or by agents via file_write); allErrors gives the responder every problem at once.
function compileSchema(schema: SkillSchema): ValidateFunction | { compileError: string } {
  try {
    return new Ajv({ allErrors: true, strict: false }).compile(schema);
  } catch (err) {
    return { compileError: err instanceof Error ? err.message : String(err) };
  }
}

// Strips an accidental ```json fence and parses the callee's final message.
function parseOutput(text: string): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
  let body = text.trim();
  const fence = body.match(/^```(?:json)?\s*\n([\s\S]*?)\n?```\s*$/);
  if (fence) body = fence[1].trim();
  if (!body) return { ok: false, error: "the response was empty" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { ok: false, error: "the response is not valid JSON (reply with a single JSON object, no prose)" };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, error: "the response must be a single JSON object" };
  }
  return { ok: true, value: parsed as Record<string, unknown> };
}

// Causes worth naming rather than flattening into EXECUTION_ERROR: no correction retry repairs them.
// The provider half is TERMINAL_PROVIDER_CODES, so a cause waiting DOES fix never lands here.
const CALLEE_TERMINAL_CODES = ["INFRASTRUCTURE_UNAVAILABLE", ...TERMINAL_PROVIDER_CODES] as const;
type CalleeTerminalCode = (typeof CALLEE_TERMINAL_CODES)[number];
type CalleeTurnFailure = { error: string; code?: CalleeTerminalCode };

const isCalleeTerminal = (code: string | undefined): code is CalleeTerminalCode =>
  CALLEE_TERMINAL_CODES.some((terminal) => terminal === code);

// One pass of the callee's loop over the persisted history; correction retries call it again on the
// same array. Usage is recorded under the CALLEE's workspace, else nested runs go unaccounted.
async function runCalleeTurn(
  run: typeof runAgent,
  messages: BaseMessage[],
  input: string,
  callee: { dir: string; id: string; name: string; maxIterations: number },
  sessionId: string,
  conversationId: string,
  opts: ExecuteSkillOptions,
  signal: AbortSignal | undefined,
  onEvent?: (event: AgentEvent) => void,
): Promise<{ text: string } | CalleeTurnFailure> {
  const recordUsage = opts.appendUsageFn ?? appendUsage;
  let text = "";
  for await (const event of run(messages, input, callee.dir, callee.id, {
    signal,
    maxIterations: callee.maxIterations,
    conversationId,
    store: opts.store,
    containers: opts.containers,
  })) {
    onEvent?.(event);
    if (event.type === "token") text += event.content;
    if (event.type === "error") {
      return {
        error: event.message,
        ...(isCalleeTerminal(event.code) ? { code: event.code } : {}),
      };
    }
    if (event.type === "turn_usage") {
      recordTurnUsage(sessionId, event, recordUsage);
    }
  }
  return { text };
}

export async function executeSkill(
  calleeId: string,
  callerId: string,
  skillId: string,
  args: Record<string, unknown>,
  opts: ExecuteSkillOptions = {},
): Promise<SkillCallResult> {
  // One id per skill call: groups the callee's usage records (shared across correction
  // retries) and disambiguates parallel calls with the same (caller, callee, skill) in logs.
  const sessionId = crypto.randomUUID();
  const elog = log.child({ callerId, calleeId, skill: skillId, sessionId });

  // 1. Authorize — the existing DAG edge is the only caller identity.
  if (!(opts.canCallFn ?? canCall)(callerId, calleeId)) {
    elog.warn("skill call rejected — no edge in graph");
    return {
      state: "failed",
      code: "NOT_CONNECTED",
      message: "this workspace is not connected to the target in the Agent Graph.",
    };
  }

  const callee = opts.store?.getWorkspace(calleeId);
  if (!callee) {
    return { state: "failed", code: "EXECUTION_ERROR", message: `workspace "${calleeId}" not found.` };
  }

  // 2. Skill lookup. MCP already resolved the skill against its own live read of .skills/, so it may
  // pass that definition and avoid a second directory read. Other callers continue to resolve live.
  const skills = opts.resolvedSkill ? [opts.resolvedSkill] : await (opts.loadSkillsFn ?? loadSkills)(callee.dir);
  const skill = skills.find((s) => s.id === skillId);
  if (!skill) {
    const available = skills.length
      ? ` Available skills: ${skills.map((s) => s.id).join(", ")}.`
      : " This workspace declares no skills.";
    return {
      state: "failed",
      code: "SKILL_NOT_FOUND",
      message: `"${callee.name}" has no skill "${skillId}".${available}`,
    };
  }

  // 3. Input validation. A schema that fails to COMPILE is the callee author's bug: report
  // EXECUTION_ERROR, since INPUT_VALIDATION_ERROR counts as a caller strike in AgentCallTool.
  const validateInput = compileSchema(skill.input);
  if ("compileError" in validateInput) {
    return {
      state: "failed",
      code: "EXECUTION_ERROR",
      message: `skill "${skillId}" has a broken input schema (the skill file needs fixing): ${validateInput.compileError}`,
    };
  }
  if (!validateInput(args)) {
    return {
      state: "failed",
      code: "INPUT_VALIDATION_ERROR",
      message: `Invalid args for ${skillId}: ${formatAjvErrors(validateInput.errors)}.`,
    };
  }

  // The author's JSON Schema unchanged: output properties stay optional unless `required` lists
  // them, as for inputs and as MCP clients discover them.
  const validateOutput = compileSchema(skill.output);
  if ("compileError" in validateOutput) {
    return {
      state: "failed",
      code: "EXECUTION_ERROR",
      message: `skill "${skillId}" has a broken output schema (the skill file needs fixing): ${validateOutput.compileError}`,
    };
  }

  // 4. Run the callee — call_agent's prompt plus a structured-responder block carrying the output
  // schema. Persisted as a real conversation in the CALLEE's workspace, so both ends can review it.
  const { loadAgentConfig } = await import("../buildTools");
  const config = loadAgentConfig(callee.id);
  const run = opts.runAgentFn ?? (await import("../runner")).runAgent;
  const caller = opts.store?.getWorkspace(callerId);

  // Created only after every pre-run rejection is ruled out, so failed validations leave no empty
  // conversations. No title, so the session is named like one started from the chat UI.
  const conv = (opts.createConversationFn ?? createConversation)(callee.id);
  const messages = (opts.getMessagesFn ?? getMessages)(callee.id, conv.id) ?? ([] as BaseMessage[]);
  refreshWorkspaceSystemPrompt(callee, messages, config);

  // Metadata and arguments in one machine-readable envelope. An ordinary user message, but JSON
  // marks the protocol boundary and keeps routing metadata out of prose.
  const callEnvelope = {
    ...(caller ? { caller: { workspaceId: caller.id, workspaceName: caller.name } } : {}),
    skill: { id: skill.id },
    args,
  };
  const firstInput = `# Skill call
${JSON.stringify(callEnvelope, null, 2)}

${buildStructuredResponderBlock(skill)}`;
  let runStatus: "success" | "failed" | "timeout" | "cancelled" = "success";
  const fail = (code: SkillErrorCode, message: string): SkillCallResult => {
    runStatus = code === "TIMEOUT" ? "timeout" : code === "CANCELLED" ? "cancelled" : "failed";
    (opts.recordRunErrorFn ?? recordRunError)(sessionId, { code, message });
    // The callee's own conversation is persisted in the finally below and is deep-linked from the
    // caller's transcript. Without this it opens on a prompt with no reply and no reason.
    noteRunError(messages, message);
    return { state: "failed", code, message, conversationId: conv.id };
  };

  // Registered with the broker so the callee's tab is live-subscribable; off-broker a deep-link shows
  // a blank "stuck" UI. Per-turn `done` is suppressed — one publishes after persist, in the finally.
  const { startExternalRun } = await import("../runBroker");
  let liveRun;
  try {
    liveRun = startExternalRun(callee.id, conv.id, firstInput, {
      sessionId,
      workspaceName: callee.name,
      origin: opts.origin ?? "agent",
      systemPrompt: messages[0]?._getType() === "system" ? contentToParagraphs(messages[0].content) : "",
      capacity: opts.capacity,
    });
  } catch (err) {
    if (!(err instanceof ExecutionCapacityReachedError)) throw err;
    messages.push(new HumanMessage(firstInput), new AIMessage(err.message));
    (opts.persistFn ?? persist)(callee.id, conv.id);
    opts.onConversationStart?.(conv.id);
    return fail("CAPACITY_REACHED", err.message);
  }

  // Whichever fires first halts the callee: the caller's deadline or Stop, this session's own Stop,
  // or the workspace timer. It becomes the opts.signal of any deeper call, so the cascade recurses.
  const runTimeout = createWorkspaceRunTimeout(callee, [opts.signal, liveRun?.signal]);
  const calleeSignal = runTimeout.signal;
  const publish = liveRun
    ? (event: AgentEvent) => {
        // Abort errors are provider-specific and often read as raw "AbortError" noise. The
        // classified timeout/cancellation branch below publishes one stable explanation instead.
        if (event.type === "error" && calleeSignal.aborted) return;
        if (event.type !== "done") liveRun.publish(event);
      }
    : undefined;

  // Announced only after the broker run is registered, so a caller clicking "View session" the
  // instant it appears finds a live run to attach to rather than an unregistered one.
  const maxRetries = opts.outputMaxRetries ?? config.skillOutputMaxRetries;
  let input = firstInput;
  let lastError = "";

  // 5. Output validation + bounded correction retries on the same live conversation, bracketed by a
  // persist() so the session survives every exit path — failures most of all.
  try {
    opts.onConversationStart?.(conv.id);
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      elog.debug({ attempt }, "skill call running callee");
      let turn: { text: string } | CalleeTurnFailure;
      try {
        turn = await runCalleeTurn(run, messages, input, callee, sessionId, conv.id, opts, calleeSignal, publish);
      } catch (err) {
        turn = { error: err instanceof Error ? err.message : String(err) };
      }
      // Check the signal independently of the runner's terminal event: an abort after a tool turn
      // can produce `done` without an error, while a model-stream abort usually produces an error.
      if (runTimeout.didTimeout()) {
        elog.warn({ attempt, maxRunMinutes: callee.maxRunMinutes }, "skill call timed out");
        liveRun?.publish({ type: "error", code: "TIMEOUT", message: runTimeout.error.message });
        return fail("TIMEOUT", runTimeout.error.message);
      }
      if (calleeSignal.aborted) {
        elog.warn({ attempt }, "skill call aborted");
        const parentReason = opts.signal?.reason;
        const message =
          parentReason instanceof WorkspaceRunTimeoutError
            ? `Workspace "${callee.name}" was cancelled because caller workspace "${parentReason.workspaceName}" timed out.`
            : liveRun?.signal.aborted
              ? USER_STOPPED_CONVERSATION_MESSAGE
              : `Workspace "${callee.name}" was cancelled before it finished.`;
        liveRun?.publish({ type: "error", code: "CANCELLED", message });
        return fail("CANCELLED", message);
      }
      if ("error" in turn) {
        elog.error(
          { event: "skill_call_execution_failed", outcome: "skill_call_failed", attempt, agentError: turn.error },
          "skill call execution error",
        );
        return fail(turn.code ?? "EXECUTION_ERROR", turn.error);
      }

      const parsed = parseOutput(turn.text);
      // Reserved envelope, checked before output validation: the callee wants different input. Not a
      // malformed response, so no correction retries — the fix comes from the caller.
      if (parsed.ok && typeof parsed.value[NEEDS_INPUT_KEY] === "string" && parsed.value[NEEDS_INPUT_KEY].trim()) {
        const question = (parsed.value[NEEDS_INPUT_KEY] as string).trim();
        elog.info({ attempt, question }, "skill call needs different input");
        return fail("NEEDS_INPUT", question);
      }
      if (parsed.ok && validateOutput(parsed.value)) {
        elog.debug({ attempt }, "skill call completed");
        return { state: "completed", output: parsed.value, conversationId: conv.id };
      }
      lastError = parsed.ok ? formatAjvErrors(validateOutput.errors) : parsed.error;
      elog.warn({ attempt, validationError: lastError }, "skill output invalid");
      input = `Your response is not valid: ${lastError}. Reply with a single corrected JSON object matching the output schema — no prose, no fences.`;
    }

    return fail("OUTPUT_VALIDATION_ERROR", lastError);
  } finally {
    runTimeout.dispose();
    (opts.persistFn ?? persist)(callee.id, conv.id);
    // Persist first, then close the live run: a client reconnecting at this instant replays from
    // the just-written committed history and receives `done` to end its stream cleanly.
    if (liveRun) {
      liveRun.publish({ type: "done" });
      liveRun.finish(runStatus);
    }
  }
}
