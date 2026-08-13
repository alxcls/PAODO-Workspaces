// executeSkill enforces the agent-to-agent skill invocation contract; exercised
// with injected fakes so it never touches disk or real workspaces.

import { describe, it, expect, vi } from "vitest";
import type { BaseMessage } from "@langchain/core/messages";

// Redirect WORKSPACES_ROOT before any infra module reads it at import time
// (executeSkill dynamically imports ../tools, which pulls in the store singletons).
// The dir never needs to exist — every read fails soft to an empty cache and the
// injected fakes below keep executeSkill from touching disk.
vi.hoisted(() => {
  process.env.WORKSPACES_ROOT = "/tmp/executeskill-test-data";
});

import { executeSkill, type ExecuteSkillOptions } from "./executeSkill";
import type { SkillDefinition } from "@/lib/skills/types";
import type { IWorkspaceStore } from "../../infra/interfaces";
import type { runAgent, AgentEvent } from "../runner";
import * as broker from "../runBroker";
import { createWorkspaceRunTimeout } from "../runTimeout";
import { ExecutionCapacity } from "../executionCapacity";

// executeSkill is the single enforcement point of the skill contract — every guarantee
// the PRD makes (authz, both-sides validation, bounded correction retries) lives here.
// The dangerous bugs are enforcement bypasses: an unauthorized caller getting through,
// bad args reaching the callee, or unvalidated output reaching the caller.

const SKILL: SkillDefinition = {
  id: "check-stock",
  description: "Returns inventory level",
  input: {
    type: "object",
    properties: { sku: { type: "string" }, format: { type: "string" } },
    required: ["sku"],
  },
  // `quantity` is deliberately optional, exercising normal JSON Schema output semantics.
  output: {
    type: "object",
    properties: { in_stock: { type: "boolean" }, quantity: { type: "number" } },
    required: ["in_stock"],
  },
};

const CALLEE = { id: "callee-1", name: "stock-agent", dir: "/tmp/nowhere", maxIterations: 5, maxRunMinutes: 5 };
const CALLER = { id: "caller-1", name: "shop-agent", dir: "/tmp/nowhere2", maxIterations: 5, maxRunMinutes: 5 };

const store = {
  getWorkspace: (id: string) => (id === CALLEE.id ? CALLEE : id === CALLER.id ? CALLER : undefined),
} as unknown as IWorkspaceStore;

// Fake runner: each call consumes the next scripted response and records the userInput
// it was driven with, so tests can assert what the callee actually saw.
function fakeRunner(responses: string[]) {
  const inputs: string[] = [];
  const run = async function* (_messages: unknown, userInput: string): AsyncGenerator<AgentEvent> {
    inputs.push(userInput);
    const text = responses[inputs.length - 1] ?? "";
    yield { type: "token", content: text };
    yield { type: "done" };
  } as unknown as typeof runAgent;
  return { run, inputs };
}

// Fake conversation store seams so the callee run is "persisted" deterministically and off disk.
// Returns a fixed conversation id the persistence assertions key off.
const FAKE_CONV_ID = "conv-test";
function fakeConvStore(): Pick<ExecuteSkillOptions, "createConversationFn" | "getMessagesFn" | "persistFn"> {
  return {
    createConversationFn: () => ({ id: FAKE_CONV_ID, title: "t", createdAt: "", updatedAt: "", lastMessageAt: "" }),
    getMessagesFn: () => [],
    persistFn: () => {},
  };
}

function opts(runner: { run: typeof runAgent }, extra: Partial<ExecuteSkillOptions> = {}): ExecuteSkillOptions {
  return {
    store,
    canCallFn: () => true,
    loadSkillsFn: async () => [SKILL],
    runAgentFn: runner.run,
    outputMaxRetries: 2,
    ...fakeConvStore(),
    ...extra,
  };
}

const GOOD_OUTPUT = JSON.stringify({ in_stock: true, quantity: 3 });

describe("executeSkill — pre-run rejections (callee must never run)", () => {
  it("uses a matching pre-resolved skill without loading the directory again", async () => {
    const runner = fakeRunner([GOOD_OUTPUT]);
    const loadSkillsFn = vi.fn(async () => []);
    const res = await executeSkill(
      CALLEE.id,
      CALLER.id,
      "check-stock",
      { sku: "A1" },
      opts(runner, {
        resolvedSkill: SKILL,
        loadSkillsFn,
      }),
    );

    expect(res.state).toBe("completed");
    expect(loadSkillsFn).not.toHaveBeenCalled();
  });

  it("returns a capacity error to the calling agent and persists the refused callee session", async () => {
    const runner = fakeRunner([GOOD_OUTPUT]);
    const capacity = new ExecutionCapacity(1);
    const occupied = capacity.tryAcquire();
    const messages: BaseMessage[] = [];
    const persistFn = vi.fn();

    const res = await executeSkill(
      CALLEE.id,
      CALLER.id,
      "check-stock",
      { sku: "A1" },
      opts(runner, {
        capacity,
        getMessagesFn: () => messages,
        persistFn,
        appendUsageFn: vi.fn(),
      }),
    );

    expect(res).toMatchObject({ state: "failed", code: "CAPACITY_REACHED", conversationId: FAKE_CONV_ID });
    expect(res.state === "failed" ? res.message : "").toContain("1/1 agent runs are active");
    expect(runner.inputs).toEqual([]);
    expect(persistFn).toHaveBeenCalledWith(CALLEE.id, FAKE_CONV_ID);
    expect(messages.at(-1)?.content).toContain("Execution capacity reached");
    occupied!.release();
  });

  it("rejects an unauthorized caller with NOT_CONNECTED", async () => {
    const runner = fakeRunner([GOOD_OUTPUT]);
    const res = await executeSkill(
      CALLEE.id,
      CALLER.id,
      "check-stock",
      { sku: "A1" },
      opts(runner, { canCallFn: () => false }),
    );
    expect(res).toMatchObject({ state: "failed", code: "NOT_CONNECTED" });
    expect(runner.inputs).toHaveLength(0);
  });

  it("rejects an unknown skill with SKILL_NOT_FOUND, listing available skills", async () => {
    const runner = fakeRunner([GOOD_OUTPUT]);
    const res = await executeSkill(CALLEE.id, CALLER.id, "nope", {}, opts(runner));
    expect(res).toMatchObject({ state: "failed", code: "SKILL_NOT_FOUND" });
    expect((res as { message: string }).message).toContain("check-stock");
    expect(runner.inputs).toHaveLength(0);
  });

  it("rejects a workspace with no skills at all with SKILL_NOT_FOUND", async () => {
    const runner = fakeRunner([GOOD_OUTPUT]);
    const res = await executeSkill(
      CALLEE.id,
      CALLER.id,
      "check-stock",
      { sku: "A1" },
      opts(runner, { loadSkillsFn: async () => [] }),
    );
    expect(res).toMatchObject({ state: "failed", code: "SKILL_NOT_FOUND" });
    expect((res as { message: string }).message).toContain("no skills");
  });

  it("rejects missing required args with a precise INPUT_VALIDATION_ERROR", async () => {
    const runner = fakeRunner([GOOD_OUTPUT]);
    const res = await executeSkill(CALLEE.id, CALLER.id, "check-stock", {}, opts(runner));
    expect(res).toMatchObject({ state: "failed", code: "INPUT_VALIDATION_ERROR" });
    expect((res as { message: string }).message).toContain("field 'sku' is required");
    expect(runner.inputs).toHaveLength(0);
  });

  it("includes the full path for a missing nested required field", async () => {
    const nested: SkillDefinition = {
      ...SKILL,
      input: {
        type: "object",
        properties: { filters: { type: "object", properties: { region: { type: "string" } }, required: ["region"] } },
        required: ["filters"],
      },
    };
    const res = await executeSkill(
      CALLEE.id,
      CALLER.id,
      "check-stock",
      { filters: {} },
      opts(fakeRunner([GOOD_OUTPUT]), { loadSkillsFn: async () => [nested] }),
    );
    expect(res).toMatchObject({ state: "failed", code: "INPUT_VALIDATION_ERROR" });
    expect((res as { message: string }).message).toContain("field 'filters.region' is required");
  });

  it("lists the allowed values for an invalid enum", async () => {
    const withEnum: SkillDefinition = {
      ...SKILL,
      input: {
        type: "object",
        properties: { mode: { type: "string", enum: ["concise", "detailed"] } },
        required: ["mode"],
      },
    };
    const res = await executeSkill(
      CALLEE.id,
      CALLER.id,
      "check-stock",
      { mode: "brief" },
      opts(fakeRunner([GOOD_OUTPUT]), { loadSkillsFn: async () => [withEnum] }),
    );
    expect(res).toMatchObject({ state: "failed", code: "INPUT_VALIDATION_ERROR" });
    expect((res as { message: string }).message).toContain('field \'mode\' must be one of: "concise", "detailed"');
  });

  it("rejects wrongly-typed args but allows extra fields (non-strict)", async () => {
    const bad = await executeSkill(CALLEE.id, CALLER.id, "check-stock", { sku: 42 }, opts(fakeRunner([GOOD_OUTPUT])));
    expect(bad).toMatchObject({ state: "failed", code: "INPUT_VALIDATION_ERROR" });

    const runner = fakeRunner([GOOD_OUTPUT]);
    const extra = await executeSkill(CALLEE.id, CALLER.id, "check-stock", { sku: "A1", surprise: true }, opts(runner));
    expect(extra.state).toBe("completed");
  });

  it("reports an uncompilable input schema as EXECUTION_ERROR, not the caller's fault", async () => {
    // INPUT_VALIDATION_ERROR would make AgentCallTool count a strike against the caller and
    // tell it to re-read the schema — useless when the skill FILE is what's broken.
    const broken: SkillDefinition = {
      ...SKILL,
      input: { type: "object", properties: { sku: { type: "not-a-type" } } },
    };
    const runner = fakeRunner([GOOD_OUTPUT]);
    const res = await executeSkill(
      CALLEE.id,
      CALLER.id,
      "check-stock",
      { sku: "A1" },
      opts(runner, { loadSkillsFn: async () => [broken] }),
    );
    expect(res).toMatchObject({ state: "failed", code: "EXECUTION_ERROR" });
    expect((res as { message: string }).message).toContain("broken input schema");
    expect(runner.inputs).toHaveLength(0);
  });
});

describe("executeSkill — callee run and output contract", () => {
  it("completes with the parsed output object and injects the structured-responder block", async () => {
    const runner = fakeRunner([GOOD_OUTPUT]);
    const res = await executeSkill(CALLEE.id, CALLER.id, "check-stock", { sku: "A1" }, opts(runner));
    expect(res).toEqual({ state: "completed", output: { in_stock: true, quantity: 3 }, conversationId: FAKE_CONV_ID });
    expect(runner.inputs).toHaveLength(1);
    expect(runner.inputs[0]).toContain("# Skill call");
    expect(runner.inputs[0]).toContain('"workspaceName": "shop-agent"');
    expect(runner.inputs[0]).toContain('"id": "check-stock"');
    expect(runner.inputs[0]).toContain('"args": {\n    "sku": "A1"\n  }');
    expect(runner.inputs[0]).toContain("Structured skill response");
    expect(runner.inputs[0]).toContain('"in_stock"'); // output schema is in the instruction
  });

  it("strips an accidental ```json fence before parsing", async () => {
    const runner = fakeRunner(["```json\n" + GOOD_OUTPUT + "\n```"]);
    const res = await executeSkill(CALLEE.id, CALLER.id, "check-stock", { sku: "A1" }, opts(runner));
    expect(res.state).toBe("completed");
  });

  it("allows extra output fields and omitted optional output fields", async () => {
    const extra = await executeSkill(
      CALLEE.id,
      CALLER.id,
      "check-stock",
      { sku: "A1" },
      opts(fakeRunner([JSON.stringify({ in_stock: true, quantity: 3, warehouse: "B" })])),
    );
    expect(extra.state).toBe("completed");

    const optionalOmitted = await executeSkill(
      CALLEE.id,
      CALLER.id,
      "check-stock",
      { sku: "A1" },
      opts(fakeRunner([JSON.stringify({ in_stock: true })]), { outputMaxRetries: 0 }),
    );
    expect(optionalOmitted).toMatchObject({ state: "completed", output: { in_stock: true } });

    const requiredMissing = await executeSkill(
      CALLEE.id,
      CALLER.id,
      "check-stock",
      { sku: "A1" },
      opts(fakeRunner([JSON.stringify({ quantity: 3 })]), { outputMaxRetries: 0 }),
    );
    expect(requiredMissing).toMatchObject({ state: "failed", code: "OUTPUT_VALIDATION_ERROR" });
    expect((requiredMissing as { message: string }).message).toContain("field 'in_stock' is required");
  });

  it("feeds the validation error back into the same conversation and succeeds on retry", async () => {
    const runner = fakeRunner([
      "Sure! The item is in stock.", // prose — parse failure
      JSON.stringify({ in_stock: true, quantity: "lots" }), // wrong type — validation failure
      GOOD_OUTPUT,
    ]);
    const res = await executeSkill(CALLEE.id, CALLER.id, "check-stock", { sku: "A1" }, opts(runner));
    expect(res.state).toBe("completed");
    expect(runner.inputs).toHaveLength(3);
    expect(runner.inputs[1]).toContain("not valid JSON");
    expect(runner.inputs[2]).toContain("'quantity' must be number");
  });

  it("resolves as OUTPUT_VALIDATION_ERROR after exhausting correction retries", async () => {
    const runner = fakeRunner(["nope", "still nope", "nope again", "never reached"]);
    const res = await executeSkill(
      CALLEE.id,
      CALLER.id,
      "check-stock",
      { sku: "A1" },
      opts(runner, { outputMaxRetries: 2 }),
    );
    expect(res).toMatchObject({ state: "failed", code: "OUTPUT_VALIDATION_ERROR" });
    expect(runner.inputs).toHaveLength(3); // initial run + 2 retries, then stop
  });

  it("records the callee's token usage under the CALLEE workspace, one session across retries", async () => {
    // Without this, nested runs are invisible in the usage dashboard — only the
    // caller's own runner is recorded by the chat route / agent stream.
    const recorded: Array<{
      sessionId: string;
      workspaceId: string;
      workspaceName: string;
      inputTokensTotal: number;
    }> = [];
    const responses = ["not json", GOOD_OUTPUT];
    let call = 0;
    const run = async function* (): AsyncGenerator<AgentEvent> {
      yield {
        type: "turn_usage",
        turnId: `turn-${call}`,
        inputTokensTotal: 100 + call,
        inputTokensCacheRead: 0,
        inputTokensCacheWrite: 0,
        outputTokensTotal: 5,
        outputTokensReasoning: 0,
        toolCalls: [],
      };
      yield { type: "token", content: responses[call++] };
      yield { type: "done" };
    } as unknown as typeof runAgent;

    const res = await executeSkill(
      CALLEE.id,
      CALLER.id,
      "check-stock",
      { sku: "A1" },
      opts(
        { run },
        {
          appendUsageFn: (r) => {
            recorded.push(r as (typeof recorded)[number]);
          },
        },
      ),
    );
    expect(res.state).toBe("completed");
    expect(recorded).toHaveLength(2); // initial run + one correction retry
    expect(recorded[0]).toMatchObject({
      workspaceId: CALLEE.id,
      workspaceName: "stock-agent",
      inputTokensTotal: 100,
    });
    expect(recorded[1].sessionId).toBe(recorded[0].sessionId);
  });

  it("returns NEEDS_INPUT when the callee replies with the reserved envelope, without burning retries", async () => {
    // The envelope is the callee saying "your schema-valid args don't resolve in my data" —
    // re-prompting the callee can't fix that, so it must short-circuit the correction loop.
    const runner = fakeRunner([
      JSON.stringify({ _needs_input: "SKU 'CMP-MOTORS' not found — did you mean CMP-MOTOR?" }),
      GOOD_OUTPUT, // must never be reached
    ]);
    const res = await executeSkill(
      CALLEE.id,
      CALLER.id,
      "check-stock",
      { sku: "CMP-MOTORS" },
      opts(runner, { outputMaxRetries: 2 }),
    );
    expect(res).toMatchObject({ state: "failed", code: "NEEDS_INPUT" });
    expect((res as { message: string }).message).toContain("did you mean CMP-MOTOR?");
    expect(runner.inputs).toHaveLength(1);
  });

  it("tells the callee about the needs-input envelope in the structured-responder block", async () => {
    const runner = fakeRunner([GOOD_OUTPUT]);
    await executeSkill(CALLEE.id, CALLER.id, "check-stock", { sku: "A1" }, opts(runner));
    expect(runner.inputs[0]).toContain('"_needs_input"');
    expect(runner.inputs[0]).toContain("input is missing or needs correction");
    expect(runner.inputs[0]).toContain("one specific question or correction");
  });

  it("treats a non-string or empty _needs_input as an invalid output, not a question", async () => {
    const runner = fakeRunner([
      JSON.stringify({ _needs_input: 42 }), // not a question — fails validation, retried
      GOOD_OUTPUT,
    ]);
    const res = await executeSkill(CALLEE.id, CALLER.id, "check-stock", { sku: "A1" }, opts(runner));
    expect(res.state).toBe("completed");
    expect(runner.inputs).toHaveLength(2);
  });

  it("returns EXECUTION_ERROR when the callee runner reports an error", async () => {
    const run = async function* (): AsyncGenerator<AgentEvent> {
      yield { type: "error", message: "model exploded" };
    } as unknown as typeof runAgent;
    const res = await executeSkill(CALLEE.id, CALLER.id, "check-stock", { sku: "A1" }, opts({ run }));
    expect(res).toEqual({
      state: "failed",
      code: "EXECUTION_ERROR",
      message: "model exploded",
      conversationId: FAKE_CONV_ID,
    });
  });

  it("preserves infrastructure-unavailable feedback for agent and MCP callers", async () => {
    const run = async function* (): AsyncGenerator<AgentEvent> {
      yield {
        type: "error",
        code: "INFRASTRUCTURE_UNAVAILABLE",
        message: "Workspace tools are unavailable because host networking capacity is exhausted.",
      };
    } as unknown as typeof runAgent;
    const res = await executeSkill(CALLEE.id, CALLER.id, "check-stock", { sku: "A1" }, opts({ run }));
    expect(res).toEqual({
      state: "failed",
      code: "INFRASTRUCTURE_UNAVAILABLE",
      message: "Workspace tools are unavailable because host networking capacity is exhausted.",
      conversationId: FAKE_CONV_ID,
    });
  });

  it("tells the caller a callee stopped for want of credit rather than reporting a generic failure", async () => {
    // A correction retry cannot repair an empty account, so the code has to survive the hop —
    // EXECUTION_ERROR would invite the caller to try the same skill again.
    const run = async function* (): AsyncGenerator<AgentEvent> {
      yield {
        type: "error",
        code: "PROVIDER_CREDIT_EXHAUSTED",
        message: "The deepseek account has run out of credit, so deepseek-chat refused the request.",
      };
    } as unknown as typeof runAgent;
    const res = await executeSkill(CALLEE.id, CALLER.id, "check-stock", { sku: "A1" }, opts({ run }));
    expect(res).toEqual({
      state: "failed",
      code: "PROVIDER_CREDIT_EXHAUSTED",
      message: "The deepseek account has run out of credit, so deepseek-chat refused the request.",
      conversationId: FAKE_CONV_ID,
    });
  });

  it("persists the callee run as a skill-call conversation in the callee workspace and returns its id", async () => {
    const createConversationFn = vi.fn(
      (_wsId: string, o?: { title?: string; kind?: "user" | "skill-call" | "scheduled" }) => ({
        id: "conv-1",
        title: o?.title ?? "",
        kind: o?.kind,
        createdAt: "",
        updatedAt: "",
        lastMessageAt: "",
      }),
    );
    const persistFn = vi.fn();

    const runner = fakeRunner([GOOD_OUTPUT]);
    const res = await executeSkill(
      CALLEE.id,
      CALLER.id,
      "check-stock",
      { sku: "A1" },
      opts(runner, { createConversationFn, getMessagesFn: () => [], persistFn }),
    );

    expect(res).toMatchObject({ state: "completed", conversationId: "conv-1" });
    expect(createConversationFn).toHaveBeenCalledWith(CALLEE.id, { kind: "skill-call" });
    expect(persistFn).toHaveBeenCalledWith(CALLEE.id, "conv-1");
  });

  it("persists and returns the conversation id even when output validation fails", async () => {
    const persistFn = vi.fn();
    const res = await executeSkill(
      CALLEE.id,
      CALLER.id,
      "check-stock",
      { sku: "A1" },
      opts(fakeRunner([JSON.stringify({ quantity: 3 })]), {
        outputMaxRetries: 0,
        createConversationFn: () => ({ id: "conv-9", title: "", createdAt: "", updatedAt: "", lastMessageAt: "" }),
        getMessagesFn: () => [],
        persistFn,
      }),
    );
    expect(res).toMatchObject({ state: "failed", code: "OUTPUT_VALIDATION_ERROR", conversationId: "conv-9" });
    expect(persistFn).toHaveBeenCalledWith(CALLEE.id, "conv-9");
  });

  it("creates no conversation for a pre-run rejection (NOT_CONNECTED)", async () => {
    const createConversationFn = vi.fn();
    const res = await executeSkill(
      CALLEE.id,
      CALLER.id,
      "check-stock",
      { sku: "A1" },
      opts(fakeRunner([GOOD_OUTPUT]), { canCallFn: () => false, createConversationFn }),
    );
    expect(res).toMatchObject({ state: "failed", code: "NOT_CONNECTED" });
    expect((res as { conversationId?: string }).conversationId).toBeUndefined();
    expect(createConversationFn).not.toHaveBeenCalled();
  });

  it("registers the callee run with the broker so its session is live-subscribable mid-flight", async () => {
    // The whole point of routing through the broker: a caller deep-linking into the callee's
    // session must be able to attach and watch it stream, not see a blank/"stuck" UI.
    let resolveGate!: () => void;
    const gate = new Promise<void>((r) => (resolveGate = r));
    const run = async function* (): AsyncGenerator<AgentEvent> {
      yield { type: "reasoning", content: "thinking…" };
      await gate; // hold the run open so the test can subscribe while it's live
      yield { type: "token", content: GOOD_OUTPUT };
      yield { type: "done" };
    } as unknown as typeof runAgent;

    const CONV = "conv-live";
    const call = executeSkill(
      CALLEE.id,
      CALLER.id,
      "check-stock",
      { sku: "A1" },
      opts(
        { run },
        {
          createConversationFn: () => ({ id: CONV, title: "", createdAt: "", updatedAt: "", lastMessageAt: "" }),
          getMessagesFn: () => [],
        },
      ),
    );

    // Give the runner a tick to emit its first token into the broker buffer.
    await new Promise((r) => setTimeout(r, 0));
    const received: AgentEvent[] = [];
    const sub = broker.subscribe(CALLEE.id, CONV, (e) => received.push(e));
    expect(sub).not.toBeNull();
    expect(sub!.replay).toContainEqual({ type: "reasoning", content: "thinking…" });
    expect(broker.isRunning(CALLEE.id, CONV)).toBe(true);

    resolveGate();
    const res = await call;
    expect(res.state).toBe("completed");
    // Live subscriber saw the rest of the run and a terminal done; run is no longer marked running.
    expect(received).toContainEqual({ type: "token", content: GOOD_OUTPUT });
    expect(received).toContainEqual({ type: "done" });
    expect(broker.isRunning(CALLEE.id, CONV)).toBe(false);
    sub!.unsubscribe();
  });

  it("publishes exactly one terminal done across correction retries (per-turn dones suppressed)", async () => {
    // A retry runs runAgent again — each turn ends in its own `done`. Forwarding those would
    // close the callee-session viewer mid-call, so only a single done is published at the end.
    const runner = fakeRunner(["not json", GOOD_OUTPUT]);
    const CONV = "conv-retry-done";
    const received: AgentEvent[] = [];
    // Subscribe synchronously after the broker session exists by intercepting the first turn.
    const res = await executeSkill(
      CALLEE.id,
      CALLER.id,
      "check-stock",
      { sku: "A1" },
      opts(runner, {
        createConversationFn: () => ({ id: CONV, title: "", createdAt: "", updatedAt: "", lastMessageAt: "" }),
        getMessagesFn: () => [],
        onConversationStart: () => {
          broker.subscribe(CALLEE.id, CONV, (e) => received.push(e));
        },
      }),
    );
    expect(res.state).toBe("completed");
    expect(received.filter((e) => e.type === "done")).toHaveLength(1);
  });

  it("halts the callee when its own conversation is stopped from the broker (callee-tab Stop)", async () => {
    // The callee's run is threaded with its broker session's abort signal, so a Stop on the
    // callee's own tab (broker.stop on the callee conversation) reaches the runner — without this
    // wiring stop() aborts a controller no one observes and the callee runs on regardless.
    const CONV = "conv-callee-stop";
    let sawAbort = false;
    const received: AgentEvent[] = [];
    const run = async function* (
      _m: unknown,
      _u: unknown,
      _d: unknown,
      _id: unknown,
      options: { signal?: AbortSignal },
    ): AsyncGenerator<AgentEvent> {
      await new Promise<void>((res) => {
        if (options.signal?.aborted) return res();
        options.signal?.addEventListener("abort", () => res());
      });
      sawAbort = options.signal?.aborted ?? false;
      yield { type: "error", message: "AbortError: This operation was aborted" };
    } as unknown as typeof runAgent;

    const call = executeSkill(
      CALLEE.id,
      CALLER.id,
      "check-stock",
      { sku: "A1" },
      opts(
        { run },
        {
          createConversationFn: () => ({ id: CONV, title: "", createdAt: "", updatedAt: "", lastMessageAt: "" }),
          getMessagesFn: () => [],
          onConversationStart: () => {
            broker.subscribe(CALLEE.id, CONV, (event) => received.push(event));
          },
        },
      ),
    );

    // Let the broker session register and the runner start awaiting its signal, then Stop the callee.
    await new Promise((r) => setTimeout(r, 0));
    expect(broker.isRunning(CALLEE.id, CONV)).toBe(true);
    expect(broker.stop(CALLEE.id, CONV)).toBe(true);

    const res = await call;
    expect(sawAbort).toBe(true);
    expect(res).toMatchObject({ state: "failed", code: "CANCELLED", conversationId: CONV });
    expect((res as { message: string }).message).toBe("Conversation stopped by the user.");
    expect(received).toEqual([
      { type: "error", code: "CANCELLED", message: "Conversation stopped by the user." },
      { type: "done" },
    ]);
  });

  it("names a parent abort as cancellation instead of leaking the runner's raw error", async () => {
    // The runner never throws on abort — it yields an error event — so executeSkill must
    // recognize the aborted signal itself for the caller to see a meaningful message.
    const run = async function* (): AsyncGenerator<AgentEvent> {
      yield { type: "error", message: "AbortError: This operation was aborted" };
    } as unknown as typeof runAgent;
    const res = await executeSkill(
      CALLEE.id,
      CALLER.id,
      "check-stock",
      { sku: "A1" },
      opts({ run }, { signal: AbortSignal.abort() }),
    );
    expect(res).toMatchObject({ state: "failed", code: "CANCELLED" });
    expect((res as { message: string }).message).toContain("cancelled");
  });

  it("halts the callee when the caller workspace deadline expires", async () => {
    let calleeObservedAbort = false;
    const recorded: Array<Record<string, unknown>> = [];
    const run = async function* (
      _m: unknown,
      _u: unknown,
      _d: unknown,
      _id: unknown,
      options: { signal?: AbortSignal },
    ): AsyncGenerator<AgentEvent> {
      await new Promise<void>((resolve) => {
        if (options.signal?.aborted) return resolve();
        options.signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      calleeObservedAbort = options.signal?.aborted ?? false;
      yield { type: "error", message: "AbortError: provider request aborted" };
    } as unknown as typeof runAgent;
    const callerTimeout = createWorkspaceRunTimeout({ ...CALLER, maxRunMinutes: 0.001 });

    try {
      const res = await executeSkill(
        CALLEE.id,
        CALLER.id,
        "check-stock",
        { sku: "A1" },
        opts(
          { run },
          {
            signal: callerTimeout.signal,
            appendUsageFn: (record) => recorded.push(record as unknown as Record<string, unknown>),
          },
        ),
      );

      expect(callerTimeout.didTimeout()).toBe(true);
      expect(calleeObservedAbort).toBe(true);
      expect(res).toMatchObject({ state: "failed", code: "CANCELLED", conversationId: FAKE_CONV_ID });
      expect(recorded).toHaveLength(1);
      expect(recorded[0]).toMatchObject({
        workspaceId: CALLEE.id,
        error: {
          code: "CANCELLED",
          message: 'Workspace "stock-agent" was cancelled because caller workspace "shop-agent" timed out.',
        },
      });
    } finally {
      callerTimeout.dispose();
    }
  });

  it("returns TIMEOUT when the callee exceeds its own workspace limit", async () => {
    const timedCallee = { ...CALLEE, maxRunMinutes: 0.001 };
    const timedStore = {
      getWorkspace: (id: string) => (id === timedCallee.id ? timedCallee : id === CALLER.id ? CALLER : undefined),
    } as unknown as IWorkspaceStore;
    const run = async function* (
      _m: unknown,
      _u: unknown,
      _d: unknown,
      _id: unknown,
      options: { signal?: AbortSignal },
    ): AsyncGenerator<AgentEvent> {
      await new Promise<void>((resolve) => {
        if (options.signal?.aborted) return resolve();
        options.signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      yield { type: "error", message: "AbortError: provider request aborted" };
    } as unknown as typeof runAgent;

    const res = await executeSkill(
      timedCallee.id,
      CALLER.id,
      "check-stock",
      { sku: "A1" },
      opts({ run }, { store: timedStore }),
    );

    expect(res).toMatchObject({ state: "failed", code: "TIMEOUT", conversationId: FAKE_CONV_ID });
    expect((res as { message: string }).message).toContain('Workspace "stock-agent" exceeded');
  });
});
