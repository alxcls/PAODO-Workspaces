// Core of structured agent-to-agent calls: a single in-process function that enforces
// both sides of a skill contract and runs the callee agent in between.
//
// Order on every call (a rejection at any pre-run step returns `failed` without running):
//   1. authorize      — workspaceGraph.canCall(callerId, calleeId)        → NOT_CONNECTED
//   2. skill lookup   — `skillId` must match a skill id in skills/        → SKILL_NOT_FOUND
//   3. input check    — args validated against `parameters` (ajv)         → INPUT_VALIDATION_ERROR
//   4. run callee     — fresh isolated runner with the structured-responder instruction
//   5. output check   — final message parsed + validated against `output`; on failure the
//      validation error is fed back into the SAME callee conversation and re-run, up to
//      SKILL_OUTPUT_MAX_RETRIES times                                     → OUTPUT_VALIDATION_ERROR
//
// Both agents live in the same Node.js process — this is an ordinary function call,
// no HTTP, no serialization.
import Ajv, { type ErrorObject, type ValidateFunction } from "ajv";
import type { BaseMessage } from "@langchain/core/messages";
import { canCall } from "../../workspace/workspaceGraph";
import { loadSkills } from "../../workspace/skillStore";
import { createConversation, getMessages, persist } from "../../workspace/conversationStore";
import { setSystemPrompt } from "../messageSerialization";
import { appendUsage, recordTurnUsage } from "../../workspace/usageStore";
import { NEEDS_INPUT_KEY, type SkillCallResult, type SkillSchema } from "../../workspace/skillTypes";
import type { IWorkspaceStore, IContainerManager } from "../../infra/interfaces";
import { buildSystemPrompt, buildPromptConfig, buildStructuredResponderBlock } from "../systemPrompt";
import { buildWorkspacePromptInputs } from "../promptContext";
import { createLogger } from "../../infra/logger";
import type { runAgent, AgentEvent } from "../runner";
// runner (and runBroker, which pulls in runner) are imported dynamically inside executeSkill to
// avoid the circular:
// tools/index → AgentCallTool → executeSkill → runner → buildTools → tools/index

const log = createLogger("executeSkill");

export interface ExecuteSkillOptions {
  signal?: AbortSignal;
  store?: IWorkspaceStore;
  containers?: IContainerManager;
  /** Test seams — production uses the real graph, skill store, runner, and conversation store. */
  canCallFn?: typeof canCall;
  loadSkillsFn?: typeof loadSkills;
  runAgentFn?: typeof runAgent;
  appendUsageFn?: typeof appendUsage;
  createConversationFn?: typeof createConversation;
  getMessagesFn?: typeof getMessages;
  persistFn?: typeof persist;
  /** Fired the instant the callee's conversation is created (before the run finishes), so the
   *  caller's UI can show the session deep-link mid-call. createConversation already writes the
   *  conversation to disk, so the link resolves immediately. */
  onConversationStart?: (conversationId: string) => void;
  outputMaxRetries?: number;
}

function formatAjvErrors(errors: ErrorObject[] | null | undefined): string {
  if (!errors?.length) return "does not match the schema";
  return errors
    .map((e) => {
      if (e.keyword === "required") {
        return `'${(e.params as { missingProperty: string }).missingProperty}' is required`;
      }
      const field = e.instancePath.replace(/^\//, "").replace(/\//g, ".");
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

// Non-strict contract, both sides: extra fields pass, declared fields must be present and
// correctly typed. For `parameters` the author's `required` array is respected as written
// (the skill template marks optionality explicitly, e.g. `format?`). For `output`, a schema
// with no `required` treats every declared property as required — "missing declared fields
// fail" — since the declared shape IS the response contract.
function withDerivedRequired(schema: SkillSchema): SkillSchema {
  if (schema.required || !schema.properties || (schema.type ?? "object") !== "object") return schema;
  return { ...schema, required: Object.keys(schema.properties) };
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

// Runs the callee's loop once on the given (persisted) message history and collects the
// final text. Output-correction retries call this again on the same array — just another
// turn on the same conversation.
// The callee's token usage is recorded under ITS OWN workspace (the chat route / agent
// stream only record the caller's runner, so nested runs would otherwise be invisible in
// the usage dashboard). One sessionId per skill call groups the run with its retries.
async function runCalleeTurn(
  run: typeof runAgent,
  messages: BaseMessage[],
  input: string,
  callee: { dir: string; id: string; name: string; maxIterations: number },
  sessionId: string,
  conversationId: string,
  opts: ExecuteSkillOptions,
  onEvent?: (event: AgentEvent) => void,
): Promise<{ text: string } | { error: string }> {
  const recordUsage = opts.appendUsageFn ?? appendUsage;
  let text = "";
  for await (const event of run(messages, input, callee.dir, callee.id, {
    signal: opts.signal,
    maxIterations: callee.maxIterations,
    store: opts.store,
    containers: opts.containers,
  })) {
    onEvent?.(event);
    if (event.type === "token") text += event.content;
    if (event.type === "error") return { error: event.message };
    if (event.type === "turn_usage") {
      recordTurnUsage({ sessionId, conversationId, workspaceId: callee.id, workspaceName: callee.name }, event, recordUsage);
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
    return { state: "failed", code: "NOT_CONNECTED", message: "this workspace is not connected to the target in the Agent Network." };
  }

  const callee = opts.store?.getWorkspace(calleeId);
  if (!callee) {
    return { state: "failed", code: "EXECUTION_ERROR", message: `workspace "${calleeId}" not found.` };
  }

  // 2. Skill lookup — read from skills/ at call time; a workspace with no skills/ is not callable.
  const skills = await (opts.loadSkillsFn ?? loadSkills)(callee.dir);
  const skill = skills.find((s) => s.id === skillId);
  if (!skill) {
    const available = skills.length ? ` Available skills: ${skills.map((s) => s.id).join(", ")}.` : " This workspace declares no skills.";
    return { state: "failed", code: "SKILL_NOT_FOUND", message: `"${callee.name}" has no skill "${skillId}".${available}` };
  }

  // 3. Input validation. A schema that fails to COMPILE is the callee author's bug, not the
  // caller's — report it as EXECUTION_ERROR so the caller isn't blamed (INPUT_VALIDATION_ERROR
  // counts as an input-failure strike in AgentCallTool, and retrying can't fix a broken file).
  const validateInput = compileSchema(skill.parameters);
  if ("compileError" in validateInput) {
    return { state: "failed", code: "EXECUTION_ERROR", message: `skill "${skillId}" has a broken parameters schema (the skill file needs fixing): ${validateInput.compileError}` };
  }
  if (!validateInput(args)) {
    return { state: "failed", code: "INPUT_VALIDATION_ERROR", message: `Invalid args for ${skillId}: ${formatAjvErrors(validateInput.errors)}.` };
  }

  const validateOutput = compileSchema(withDerivedRequired(skill.output));
  if ("compileError" in validateOutput) {
    return { state: "failed", code: "EXECUTION_ERROR", message: `skill "${skillId}" has a broken output schema (the skill file needs fixing): ${validateOutput.compileError}` };
  }

  // 4. Run the callee — same prompt construction the free-form call_agent used, plus the
  // structured-responder block carrying this skill's output schema. The run is persisted as a
  // real conversation in the CALLEE's workspace so the caller's UI can deep-link to it and the
  // operator can review the full session (reasoning, tool calls, messages) in the callee's tab.
  const { loadAgentConfig } = await import("../buildTools");
  const config = loadAgentConfig();
  const run = opts.runAgentFn ?? (await import("../runner")).runAgent;
  const inputs = buildWorkspacePromptInputs(callee.id, callee.dir);
  const caller = opts.store?.getWorkspace(callerId);

  // Created only now, after every pre-run rejection has been ruled out, so failed validations
  // never leave empty conversations behind.
  // No explicit title: fall back to createConversation's default (short id label), so a
  // call_agent session is named exactly like one started from the chat UI. `kind` is kept for
  // provenance only — it's not surfaced in the conversation list.
  const conv = (opts.createConversationFn ?? createConversation)(callee.id, {
    kind: "skill-call",
  });
  const messages = (opts.getMessagesFn ?? getMessages)(callee.id, conv.id) ?? ([] as BaseMessage[]);
  setSystemPrompt(messages, buildSystemPrompt(callee.dir, buildPromptConfig(config), inputs));

  const firstInput = `${caller ? `[From: ${caller.name}] ` : ""}Skill call: ${skill.id}${skill.name !== skill.id ? ` (${skill.name})` : ""}
Args:
${JSON.stringify(args, null, 2)}

${buildStructuredResponderBlock(skill)}`;

  // Register the callee's run with the run broker so its conversation tab is live-subscribable
  // while it works — without this the callee runs entirely off-broker and a caller deep-linking
  // into the session sees a blank, "stuck" UI (no broker session to attach to, history persisted
  // only at the end). Imported dynamically to keep executeSkill out of the runBroker→runner cycle.
  // The per-turn `done` events runAgent emits are suppressed; a single `done` is published in the
  // finally below, after persist, so a correction retry never prematurely closes a subscriber.
  const { startExternalRun } = await import("../runBroker");
  const liveRun = startExternalRun(callee.id, conv.id, firstInput);
  const publish = liveRun
    ? (event: AgentEvent) => { if (event.type !== "done") liveRun.publish(event); }
    : undefined;

  // Announce the session only now — after the broker run is registered — so a caller that clicks
  // the "View session" link the instant it appears finds a live run to attach to, not an empty
  // (not-yet-registered) session. createConversation already wrote it to disk, so it resolves.
  opts.onConversationStart?.(conv.id);

  const maxRetries = opts.outputMaxRetries ?? config.skillOutputMaxRetries;
  let input = firstInput;
  let lastError = "";

  // 5. Output validation + bounded correction retries on the same live conversation. The whole
  // loop is bracketed by a persist() so the session is saved on every exit path — including
  // failures, which are the ones most worth inspecting.
  try {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      elog.debug({ attempt }, "skill call running callee");
      let turn: { text: string } | { error: string };
      try {
        turn = await runCalleeTurn(run, messages, input, callee, sessionId, conv.id, opts, publish);
      } catch (err) {
        turn = { error: err instanceof Error ? err.message : String(err) };
      }
      if ("error" in turn) {
        // The runner catches everything (including aborts) and yields an error event, so an
        // abort surfaces here — name it instead of leaking a raw "operation was aborted".
        if (opts.signal?.aborted) {
          elog.warn({ attempt }, "skill call aborted");
          return { state: "failed", code: "EXECUTION_ERROR", message: "the call was aborted before the agent finished (timeout or cancellation).", conversationId: conv.id };
        }
        elog.error({ attempt, agentError: turn.error }, "skill call execution error");
        return { state: "failed", code: "EXECUTION_ERROR", message: turn.error, conversationId: conv.id };
      }

      const parsed = parseOutput(turn.text);
      // Reserved envelope, checked before output validation: the callee asked for different
      // input instead of answering. Not a malformatted response, so no correction retries —
      // the fix has to come from the caller, not from re-prompting the callee.
      if (parsed.ok && typeof parsed.value[NEEDS_INPUT_KEY] === "string" && parsed.value[NEEDS_INPUT_KEY].trim()) {
        const question = (parsed.value[NEEDS_INPUT_KEY] as string).trim();
        elog.info({ attempt, question }, "skill call needs different input");
        return { state: "failed", code: "NEEDS_INPUT", message: question, conversationId: conv.id };
      }
      if (parsed.ok && validateOutput(parsed.value)) {
        elog.debug({ attempt }, "skill call completed");
        return { state: "completed", output: parsed.value, conversationId: conv.id };
      }
      lastError = parsed.ok ? formatAjvErrors(validateOutput.errors) : parsed.error;
      elog.warn({ attempt, validationError: lastError }, "skill output invalid");
      input = `Your response is not valid: ${lastError}. Reply with a single corrected JSON object matching the output schema — no prose, no fences.`;
    }

    return { state: "failed", code: "OUTPUT_VALIDATION_ERROR", message: lastError, conversationId: conv.id };
  } finally {
    (opts.persistFn ?? persist)(callee.id, conv.id);
    // Persist first, then close the live run: a client reconnecting at this instant replays from
    // the just-written on-disk history and receives `done` to end its stream cleanly.
    if (liveRun) {
      liveRun.publish({ type: "done" });
      liveRun.finish();
    }
  }
}
