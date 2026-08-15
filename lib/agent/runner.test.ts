// runAgent must leave conversation history consistent when an aborted request
// abandons the streaming generator mid tool-call turn.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { AIMessage, AIMessageChunk, ToolMessage, type BaseMessage } from "@langchain/core/messages";
import { runAgent, classifyToolStatus, type AgentEvent } from "./runner";
import { buildSignalHandlers } from "./buildTools";
import { SUPPORTED_PROVIDERS, providerAvailabilityEnv } from "./buildModel";
import { usageTokens } from "./modelGateway";
import { prepareMistralMessages } from "./mistralProtocol";

// Every test below runs on "deepseek", and runAgent refuses a switched-off provider. Pinning the
// availability vars keeps a developer's own shell from failing the whole file at preflight.
beforeEach(() => {
  for (const provider of SUPPORTED_PROVIDERS) vi.stubEnv(providerAvailabilityEnv(provider)!, "true");
});
afterEach(() => vi.unstubAllEnvs());

// An abort abandons the generator at whatever yield it is suspended on. The invariant: history then
// holds the whole tool-call turn or none of it, never tool_calls without their ToolMessages.

type Chunk = AIMessageChunk;

// True if any assistant tool-call turn has a tool_call without a matching ToolMessage after it.
function hasUnansweredToolCalls(messages: BaseMessage[]): boolean {
  return messages.some((m, i) => {
    if (!(m instanceof AIMessage) || !m.tool_calls?.length) return false;
    const answered = new Set(
      messages
        .slice(i + 1)
        .filter((t): t is ToolMessage => t instanceof ToolMessage)
        .map((t) => t.tool_call_id),
    );
    return !m.tool_calls.every((tc) => tc.id && answered.has(tc.id));
  });
}

// A fake gateway replaying scripted chunks per turn — tool calls or plain text. Returns a real
// ModelStream handle, accumulating as it goes so usage is only correct after the loop, as in production.
function makeBuildTools(turns: Chunk[][], executeResult = "command ran", provider = "deepseek") {
  let turn = 0;
  const modelWithTools = {
    provider,
    model: "test-model",
    stream: async (_messages: BaseMessage[], _call: { stage: string; signal?: AbortSignal }) => {
      const chunks = turns[turn++] ?? [];
      let accumulated: Chunk | null = null;
      return {
        chunks: (async function* () {
          for (const c of chunks) {
            accumulated = accumulated ? accumulated.concat(c) : c;
            yield c;
          }
        })(),
        accumulated: () => accumulated,
        usage: () => usageTokens(accumulated),
      };
    },
  };
  const toolMap = {
    execute_command: { invoke: async () => executeResult },
    workspace_restore: { invoke: async () => "[restoring]" },
  };
  return () => ({ modelWithTools, model: modelWithTools, toolMap, signalHandlers: {} }) as never;
}

describe("runAgent — provider-specific history compatibility", () => {
  const history = (id: string): BaseMessage[] => [
    new AIMessage({ content: "", tool_calls: [{ id, name: "execute_command", args: { cmd: "true" } }] }),
    new ToolMessage({ tool_call_id: id, content: "done" }),
  ];

  it("keeps native ids for providers that accept them", async () => {
    const messages = history("call_native_openai_id");
    const buildAgentTools = makeBuildTools([[new AIMessageChunk({ content: "done" })]]);

    for await (const _ of runAgent(messages, "continue", "/tmp/ws", "ws-1", { ...noopDeps, buildAgentTools })) {
      // drain
    }

    expect((messages[0] as AIMessage).tool_calls![0].id).toBe("call_native_openai_id");
    expect((messages[1] as ToolMessage).tool_call_id).toBe("call_native_openai_id");
  });

  it("leaves canonical ids unchanged for Mistral because its gateway adapts only the outbound copy", async () => {
    const messages = history("toolu_01A09q9rDJmwvLpPCJKtxpvB");
    const buildAgentTools = makeBuildTools([[new AIMessageChunk({ content: "done" })]], "command ran", "mistral");

    for await (const _ of runAgent(messages, "continue", "/tmp/ws", "ws-1", {
      ...noopDeps,
      loadConfig: () => ({ provider: "mistral", model: "mistral-medium-latest", apiKey: "sk" }) as never,
      buildAgentTools,
    })) {
      // drain
    }

    expect((messages[0] as AIMessage).tool_calls![0].id).toBe("toolu_01A09q9rDJmwvLpPCJKtxpvB");
    expect((messages[1] as ToolMessage).tool_call_id).toBe("toolu_01A09q9rDJmwvLpPCJKtxpvB");
  });
});

// The real production workspace_restore handler, so runner-dispatch tests exercise the same code
// path the app runs (no hand-mirrored copy that can silently drift out of sync).
const restoreHandler = buildSignalHandlers().workspace_restore;

// One chunk carrying one or more tool calls (each a distinct execute_command so dedup keeps all).
function toolCallsChunk(...calls: { id: string; args: string }[]): Chunk {
  return new AIMessageChunk({
    content: "",
    tool_call_chunks: calls.map((c, index) => ({
      index,
      id: c.id,
      name: "execute_command",
      args: c.args,
      type: "tool_call_chunk",
    })),
  });
}

// One chunk carrying a single named tool call — for tools other than execute_command.
function namedToolCallChunk(name: string, id: string, args: string): Chunk {
  return new AIMessageChunk({
    content: "",
    tool_call_chunks: [{ index: 0, id, name, args, type: "tool_call_chunk" }],
  });
}

const noopDeps = {
  notify: () => {},
  warmContainer: () => {},
  // A runnable config: an offered provider with a key. runAgent's preflight stops any run that lacks
  // either, so a config without them would end every test below at the first yield.
  loadConfig: () => ({ provider: "deepseek", model: "deepseek-v4-flash", apiKey: "sk-test" }) as never,
  containers: {} as never,
  store: {} as never,
};

describe("runAgent — history stays consistent across aborts", () => {
  it("commits nothing for the turn when abandoned before the tools run (abort at tool_start)", async () => {
    const messages: BaseMessage[] = [];
    const buildAgentTools = makeBuildTools([[toolCallsChunk({ id: "call_1", args: '{"cmd":"node server.js"}' })]]);

    // Mimic escape mid-tool-call: stop iterating (break ⇒ gen.return()) at the first tool_start,
    // before any tool result. This is the point where the original bug left a dangling AIMessage.
    for await (const event of runAgent(messages, "run the server", "/tmp/ws", "ws-1", {
      ...noopDeps,
      buildAgentTools,
    })) {
      if (event.type === "tool_start") break;
    }

    expect(messages.some((m) => m instanceof AIMessage && (m.tool_calls?.length ?? 0) > 0)).toBe(false);
    expect(hasUnansweredToolCalls(messages)).toBe(false);
  });

  it("commits the whole multi-tool turn atomically when abandoned after the tools run (abort at tool_result)", async () => {
    const messages: BaseMessage[] = [];
    const buildAgentTools = makeBuildTools([
      [toolCallsChunk({ id: "call_1", args: '{"cmd":"a"}' }, { id: "call_2", args: '{"cmd":"b"}' })],
    ]);

    // Abandon at the first tool_result — which the runner yields only *after* committing the
    // AIMessage and both ToolMessages. A non-atomic commit would leave call_2 unanswered here.
    for await (const event of runAgent(messages, "do two things", "/tmp/ws", "ws-1", {
      ...noopDeps,
      buildAgentTools,
    })) {
      if (event.type === "tool_result") break;
    }

    expect(hasUnansweredToolCalls(messages)).toBe(false);
    const answered = messages.filter((m): m is ToolMessage => m instanceof ToolMessage).map((m) => m.tool_call_id);
    expect(answered).toEqual(["call_1", "call_2"]);
  });

  it("persists a complete tool turn and finishes on a normal (un-aborted) run", async () => {
    const messages: BaseMessage[] = [];
    const buildAgentTools = makeBuildTools([
      [toolCallsChunk({ id: "call_1", args: '{"cmd":"ls"}' })],
      [new AIMessageChunk({ content: "done" })],
    ]);

    const events: AgentEvent[] = [];
    for await (const event of runAgent(messages, "list files", "/tmp/ws", "ws-1", { ...noopDeps, buildAgentTools })) {
      events.push(event);
    }

    expect(hasUnansweredToolCalls(messages)).toBe(false);
    expect(messages.some((m) => m instanceof ToolMessage && m.tool_call_id === "call_1")).toBe(true);
    expect(events.at(-1)).toEqual({ type: "done" });
  });

  it("links every persisted AI message to its own execution-turn record", async () => {
    const messages: BaseMessage[] = [];
    const buildAgentTools = makeBuildTools([
      [toolCallsChunk({ id: "call_1", args: '{"cmd":"ls"}' })],
      [new AIMessageChunk({ content: "done" })],
    ]);
    const events: AgentEvent[] = [];

    for await (const event of runAgent(messages, "list files", "/tmp/ws", "ws-1", {
      ...noopDeps,
      buildAgentTools,
    })) {
      events.push(event);
    }

    const turnIds = events
      .filter((event): event is Extract<AgentEvent, { type: "turn_usage" }> => event.type === "turn_usage")
      .map((event) => event.turnId);
    const messageTurnIds = messages
      .filter((message): message is AIMessage => message instanceof AIMessage)
      .map((message) => message.response_metadata.executionTurnId);

    expect(turnIds).toHaveLength(2);
    expect(new Set(turnIds).size).toBe(2);
    expect(messageTurnIds).toEqual(turnIds);
  });

  it("records a returned tool error as an error outcome", async () => {
    const buildAgentTools = makeBuildTools(
      [[toolCallsChunk({ id: "call_1", args: '{"cmd":"false"}' })], [new AIMessageChunk({ content: "recovered" })]],
      "Error: command exited with code 1",
    );
    const events: AgentEvent[] = [];

    for await (const event of runAgent([], "run command", "/tmp/ws", "ws-1", { ...noopDeps, buildAgentTools })) {
      events.push(event);
    }

    const usage = events.find(
      (event): event is Extract<AgentEvent, { type: "turn_usage" }> => event.type === "turn_usage",
    );
    expect(usage?.toolCalls).toEqual([expect.objectContaining({ name: "execute_command", status: "error" })]);
  });

  it("ends the run after a non-retryable Docker network-capacity tool failure", async () => {
    const buildAgentTools = makeBuildTools(
      [
        [toolCallsChunk({ id: "call_1", args: '{"cmd":"ls"}' })],
        [new AIMessageChunk({ content: "must not be reached" })],
      ],
      "Error: [DOCKER_NETWORK_POOL_EXHAUSTED] workspace network unavailable",
    );
    const events: AgentEvent[] = [];

    for await (const event of runAgent([], "list files", "/tmp/ws", "ws-1", { ...noopDeps, buildAgentTools })) {
      events.push(event);
    }

    expect(events.filter((event) => event.type === "error")).toEqual([
      expect.objectContaining({ type: "error", code: "INFRASTRUCTURE_UNAVAILABLE" }),
    ]);
    expect(events.at(-1)).toEqual({ type: "done" });
    expect(events.filter((event) => event.type === "turn_usage")).toHaveLength(1);
  });

  it("names the empty provider account when the model refuses, instead of leaking the raw error", async () => {
    // What 20 workspaces on one dry DeepSeek key produced. `String(err)` alone never says whose
    // account it was, or that no retry can get past it.
    const buildAgentTools = () =>
      ({
        modelWithTools: {
          stream: async () => {
            throw Object.assign(new Error("402 Insufficient Balance"), { status: 402 });
          },
        },
        model: {},
        toolMap: {},
        signalHandlers: {},
      }) as never;
    const events: AgentEvent[] = [];

    for await (const event of runAgent([], "do work", "/tmp/ws", "ws-1", {
      ...noopDeps,
      loadConfig: () => ({ provider: "deepseek", model: "deepseek-v4-flash", apiKey: "sk-test" }) as never,
      buildAgentTools,
    })) {
      events.push(event);
    }

    const failure = events.find((event) => event.type === "error");
    expect(failure).toMatchObject({ code: "PROVIDER_CREDIT_EXHAUSTED" });
    expect(failure && "message" in failure ? failure.message : "").toContain("deepseek account has run out of credit");
    expect(events.at(-1)).toEqual({ type: "done" });
  });

  it("persists a reasoning-model tool turn as coalesced text, not raw streamed blocks", async () => {
    const messages: BaseMessage[] = [];
    // An extended-thinking chunk, whose content is provider blocks. Persisting the raw array froze
    // streaming-only blocks into history, which a later request rejected. Save coalesced text instead.
    const reasoningToolChunk = new AIMessageChunk({
      content: [
        { index: 0, type: "thinking", thinking: "I should list the files.", signature: "sig" },
        { index: 1, type: "text", text: "Let me list the files." },
      ] as never,
      tool_call_chunks: [
        { index: 2, id: "call_1", name: "execute_command", args: '{"cmd":"ls"}', type: "tool_call_chunk" },
      ],
    });
    const buildAgentTools = makeBuildTools([[reasoningToolChunk], [new AIMessageChunk({ content: "done" })]]);

    for await (const _ of runAgent(messages, "list files", "/tmp/ws", "ws-1", { ...noopDeps, buildAgentTools })) {
      /* drain */
    }

    const toolTurn = messages.find((m): m is AIMessage => m instanceof AIMessage && (m.tool_calls?.length ?? 0) > 0);
    expect(toolTurn).toBeDefined();
    expect(typeof toolTurn!.content).toBe("string");
    expect(toolTurn!.content).toBe("Let me list the files.");
    // No streaming-only artifact survives into persisted history.
    expect(JSON.stringify(messages)).not.toMatch(/thinking|input_json_delta/);
  });

  it("keeps Mistral reasoning private while restoring it for the next provider request", async () => {
    const messages: BaseMessage[] = [];
    const reasoningToolChunk = new AIMessageChunk({
      content: [
        {
          index: 0,
          type: "thinking",
          thinking: [
            { type: "text", text: "I should " },
            { type: "text", text: "list the files." },
          ],
        },
        { index: 1, type: "text", text: "Let me list the files." },
      ] as never,
      tool_call_chunks: [
        { index: 2, id: "abc123XYZ", name: "execute_command", args: '{"cmd":"ls"}', type: "tool_call_chunk" },
      ],
    });
    const buildAgentTools = makeBuildTools(
      [[reasoningToolChunk], [new AIMessageChunk({ content: "done" })]],
      "command ran",
      "mistral",
    );
    const events: AgentEvent[] = [];

    for await (const event of runAgent(messages, "list files", "/tmp/ws", "ws-1", {
      ...noopDeps,
      loadConfig: () => ({ provider: "mistral", model: "mistral-medium-latest", apiKey: "sk" }) as never,
      buildAgentTools,
    })) {
      events.push(event);
    }

    const toolTurnIndex = messages.findIndex(
      (message) => message instanceof AIMessage && (message.tool_calls?.length ?? 0) > 0,
    );
    const toolTurn = messages[toolTurnIndex] as AIMessage;
    const outbound = prepareMistralMessages(messages)[toolTurnIndex] as AIMessage;

    expect(toolTurn.content).toBe("Let me list the files.");
    expect(outbound.content).toEqual([
      { type: "thinking", thinking: [{ type: "text", text: "I should list the files." }] },
      { type: "text", text: "Let me list the files." },
    ]);
    expect(events.filter((event) => event.type === "reasoning").map((event) => event.content)).toEqual([
      "I should list the files.",
    ]);
  });
});

// Records every versioning call so tests can assert the run is bracketed by exactly one baseline
// and one result commit, with the expected summary, on each exit path.
function makeVersioning() {
  const calls: { method: string; args: unknown[] }[] = [];
  const rec =
    (method: string) =>
    (...args: unknown[]) => {
      calls.push({ method, args });
    };
  return {
    calls,
    versioning: {
      initRepo: rec("initRepo") as never,
      commitBaseline: (async (...a: unknown[]) => {
        calls.push({ method: "commitBaseline", args: a });
        return { sha: "base" };
      }) as never,
      commitResult: (async (...a: unknown[]) => {
        calls.push({ method: "commitResult", args: a });
        return { sha: "res", changed: true };
      }) as never,
      history: rec("history") as never,
      diff: rec("diff") as never,
      versionStats: rec("versionStats") as never,
      versionDiff: rec("versionDiff") as never,
      restore: (async (...a: unknown[]) => {
        calls.push({ method: "restore", args: a });
        return true;
      }) as never,
      deleteRepo: rec("deleteRepo") as never,
      isGitAvailable: (async () => true) as never,
    },
  };
}

describe("runAgent — git versioning brackets every run", () => {
  it("snapshots a baseline before any turn, then one result commit labelled with the prompt", async () => {
    const { calls, versioning } = makeVersioning();
    const buildAgentTools = makeBuildTools([
      [toolCallsChunk({ id: "call_1", args: '{"cmd":"ls"}' })],
      [new AIMessageChunk({ content: "all done" })],
    ]);

    for await (const _ of runAgent([], "list files", "/tmp/ws", "ws-1", { ...noopDeps, versioning, buildAgentTools })) {
      /* drain */
    }

    const baseline = calls.filter((c) => c.method === "commitBaseline");
    const result = calls.filter((c) => c.method === "commitResult");
    expect(baseline).toHaveLength(1);
    expect(result).toHaveLength(1);
    // baseline runs before the result commit; both carry the user prompt as the label.
    expect(calls[0].method).toBe("commitBaseline");
    expect(baseline[0].args).toEqual(["ws-1", "/tmp/ws", "list files"]);
    expect(result[0].args).toEqual(["ws-1", "/tmp/ws", "list files"]);
  });

  it("still commits a result on abort, falling back to the prompt as the summary", async () => {
    const { calls, versioning } = makeVersioning();
    const buildAgentTools = makeBuildTools([[toolCallsChunk({ id: "call_1", args: '{"cmd":"x"}' })]]);

    // Abort mid-run: break at tool_start abandons the generator, whose `finally` must still fire.
    for await (const event of runAgent([], "do the thing", "/tmp/ws", "ws-1", {
      ...noopDeps,
      versioning,
      buildAgentTools,
    })) {
      if (event.type === "tool_start") break;
    }

    const result = calls.filter((c) => c.method === "commitResult");
    expect(result).toHaveLength(1);
    expect(result[0].args).toEqual(["ws-1", "/tmp/ws", "do the thing"]);
  });

  it("commits a result when the iteration limit is reached", async () => {
    const { calls, versioning } = makeVersioning();
    // maxIterations:1 → first turn calls a tool, then the limit trips on the next loop.
    const buildAgentTools = makeBuildTools([[toolCallsChunk({ id: "call_1", args: '{"cmd":"y"}' })]]);

    for await (const _ of runAgent([], "keep going", "/tmp/ws", "ws-1", {
      ...noopDeps,
      versioning,
      buildAgentTools,
      maxIterations: 1,
    })) {
      /* drain */
    }

    expect(calls.filter((c) => c.method === "commitBaseline")).toHaveLength(1);
    expect(calls.filter((c) => c.method === "commitResult")).toHaveLength(1);
  });

  it("runs unchanged when no versioning service is injected", async () => {
    const buildAgentTools = makeBuildTools([[new AIMessageChunk({ content: "hi" })]]);
    const events: AgentEvent[] = [];
    for await (const event of runAgent([], "hello", "/tmp/ws", "ws-1", { ...noopDeps, buildAgentTools })) {
      events.push(event);
    }
    expect(events.at(-1)).toEqual({ type: "done" });
  });
});

describe("runAgent — agent-initiated workspace_restore is runner-mediated", () => {
  it("restores to the named snapshot when workspace_restore carries a sha", async () => {
    const { calls, versioning } = makeVersioning();
    const buildAgentTools = makeBuildTools([
      [namedToolCallChunk("workspace_restore", "call_1", '{"sha":"abad1de"}')],
      [new AIMessageChunk({ content: "done" })],
    ]);

    for await (const _ of runAgent([], "fix it", "/tmp/ws", "ws-1", {
      ...noopDeps,
      versioning,
      buildAgentTools,
      signalHandlers: { workspace_restore: restoreHandler },
    })) {
      /* drain */
    }

    const restore = calls.filter((c) => c.method === "restore");
    expect(restore).toHaveLength(1);
    expect(restore[0].args).toEqual(["ws-1", "/tmp/ws", "abad1de"]);
  });

  it("does not restore when workspace_restore is called without a sha", async () => {
    const { calls, versioning } = makeVersioning();
    const buildAgentTools = makeBuildTools([
      [namedToolCallChunk("workspace_restore", "call_1", "{}")],
      [new AIMessageChunk({ content: "retried from clean state" })],
    ]);

    for await (const _ of runAgent([], "fix it", "/tmp/ws", "ws-1", {
      ...noopDeps,
      versioning,
      buildAgentTools,
      signalHandlers: { workspace_restore: restoreHandler },
    })) {
      /* drain */
    }

    const restore = calls.filter((c) => c.method === "restore");
    expect(restore).toHaveLength(0);
  });

  it("does not restore when no versioning service is injected", async () => {
    const buildAgentTools = makeBuildTools([
      [namedToolCallChunk("workspace_restore", "call_1", "{}")],
      [new AIMessageChunk({ content: "ok" })],
    ]);
    const events: AgentEvent[] = [];
    for await (const event of runAgent([], "fix it", "/tmp/ws", "ws-1", { ...noopDeps, buildAgentTools })) {
      events.push(event);
    }
    // Nothing to assert on versioning (absent); the run must simply complete cleanly.
    expect(events.at(-1)).toEqual({ type: "done" });
  });
});

describe("classifyToolStatus", () => {
  it("classifies success, the Error/Permission-denied convention, and the A2A needs-input tag", () => {
    expect(classifyToolStatus("line1\nline2")).toBe("ok");
    expect(classifyToolStatus("Command executed successfully with no output.")).toBe("ok");
    expect(classifyToolStatus("Error: command exited with code 1\nbuild failed")).toBe("error");
    expect(classifyToolStatus("Error (INPUT_VALIDATION_ERROR): missing field")).toBe("error");
    expect(classifyToolStatus('Error: unknown tool "foo"')).toBe("error");
    expect(classifyToolStatus("Permission denied: not connected")).toBe("error");
    expect(classifyToolStatus('Needs input: the target agent needs different input: "which warehouse?"')).toBe(
      "needs_input",
    );
  });
});

// Direct coverage of the production handlers, pinning the PostDispatchFn contract: each catches and
// logs its own errors, so a side-effect failure never escapes into the run loop.
describe("buildSignalHandlers", () => {
  function makeCtx(
    over: Partial<import("./interfaces").PostDispatchContext> = {},
  ): import("./interfaces").PostDispatchContext {
    return {
      messages: [],
      versioning: undefined,
      workspaceId: "ws-1",
      workspaceDir: "/tmp/ws",
      model: undefined,
      notify: () => {},
      log: { warn: () => {}, debug: () => {} },
      ...over,
    };
  }

  it("workspace_restore restores and notifies on an ok result", async () => {
    const { calls, versioning } = makeVersioning();
    const notes: object[] = [];
    const ctx = makeCtx({
      versioning,
      notify: (m) => {
        notes.push(m);
      },
    });
    await buildSignalHandlers().workspace_restore({ sha: "abad1de" }, "restored", ctx);
    expect(calls.filter((c) => c.method === "restore")).toHaveLength(1);
    expect(notes).toEqual([{ type: "snapshot_restored", sha: "abad1de" }]);
  });

  it("workspace_restore skips when the tool result is an error", async () => {
    const { calls, versioning } = makeVersioning();
    const ctx = makeCtx({ versioning });
    await buildSignalHandlers().workspace_restore({ sha: "abad1de" }, "Error: nope", ctx);
    expect(calls.filter((c) => c.method === "restore")).toHaveLength(0);
  });

  it("workspace_restore swallows a thrown restore error", async () => {
    const warnings: object[] = [];
    const versioning = {
      restore: async () => {
        throw new Error("git boom");
      },
    } as never;
    const ctx = makeCtx({
      versioning,
      log: {
        warn: (o: object) => {
          warnings.push(o);
        },
        debug: () => {},
      },
    });
    await expect(buildSignalHandlers().workspace_restore({ sha: "abad1de" }, "ok", ctx)).resolves.toBeUndefined();
    expect(warnings).toHaveLength(1);
  });

  it("compact_context swallows an applyCompaction error instead of throwing into the run", async () => {
    const warnings: object[] = [];
    const model = {
      invoke: async () => {
        throw new Error("summarize boom");
      },
    } as never;
    const ctx = makeCtx({
      model,
      log: {
        warn: (o: object) => {
          warnings.push(o);
        },
        debug: () => {},
      },
    });
    await expect(
      buildSignalHandlers().compact_context({ level: "hard", next_step: "carry on" }, "ok", ctx),
    ).resolves.toBeUndefined();
    expect(warnings).toHaveLength(1);
  });

  it("compact_context is a no-op when the model is absent", async () => {
    const ctx = makeCtx({ model: undefined });
    await expect(
      buildSignalHandlers().compact_context({ level: "hard", next_step: "carry on" }, "ok", ctx),
    ).resolves.toBeUndefined();
  });
});

// The BYOK failure path. "No key" is the state every deployment starts in, so it must end the run
// with something the operator can act on, before anything is spent or started.
describe("runAgent — refuses to start without a usable provider", () => {
  // Anything reaching this means the preflight ran too late: buildTools constructs the provider
  // client, and runAgent pre-warms a container on the way past.
  const explode = () => {
    throw new Error("built the model despite having no usable provider");
  };

  async function collect(config: Record<string, unknown>) {
    const events: AgentEvent[] = [];
    for await (const event of runAgent([], "do work", "/tmp/ws", "ws-1", {
      ...noopDeps,
      loadConfig: () => config as never,
      buildAgentTools: explode as never,
      warmContainer: explode,
    })) {
      events.push(event);
    }
    return events;
  }

  it("stops with a message naming the provider when no key is set", async () => {
    const events = await collect({ provider: "deepseek", model: "deepseek-v4-flash" });

    expect(events).toEqual([
      { type: "error", code: "PROVIDER_KEY_MISSING", message: expect.stringContaining("No API key set for deepseek") },
      { type: "done" },
    ]);
  });

  it("blames the switch, not the key, for a provider this deployment withdrew", async () => {
    vi.stubEnv("DEEPSEEK_AVAILABLE", "false");

    const events = await collect({ provider: "deepseek", model: "deepseek-v4-flash" });

    expect(events[0]).toMatchObject({ type: "error", code: "PROVIDER_UNAVAILABLE" });
  });

  it("stops a retired model and requires an explicit UI choice", async () => {
    const events = await collect({ provider: "mistral", model: "mistral-small-2603", apiKey: "sk" });

    expect(events).toEqual([
      {
        type: "error",
        code: "MODEL_UNAVAILABLE",
        message: expect.stringContaining("choose a current model"),
      },
      { type: "done" },
    ]);
  });

  // Closing the stream properly matters as much as the message: the SSE consumer and runBroker both
  // key off `done`, and a generator that just returns leaves the run showing as still working.
  it("always closes the stream with done", async () => {
    const events = await collect({ provider: "deepseek", model: "deepseek-v4-flash" });
    expect(events.at(-1)).toEqual({ type: "done" });
  });

  it("leaves the conversation history untouched", async () => {
    // Not even the user's message is appended: nothing happened, so replaying this conversation
    // later must not show a turn that never ran.
    const messages: BaseMessage[] = [];
    for await (const _ of runAgent(messages, "do work", "/tmp/ws", "ws-1", {
      ...noopDeps,
      loadConfig: () => ({ provider: "deepseek", model: "deepseek-v4-flash" }) as never,
      buildAgentTools: explode as never,
      warmContainer: explode,
    })) {
      // drain
    }
    expect(messages).toEqual([]);
  });

  it("runs normally the moment a key is present", async () => {
    // The same config that failed above, plus a key — so the preflight is what differed, not the
    // surrounding setup.
    const buildAgentTools = makeBuildTools([[new AIMessageChunk({ content: "hello" })]]);
    const events: AgentEvent[] = [];
    for await (const event of runAgent([], "do work", "/tmp/ws", "ws-1", {
      ...noopDeps,
      loadConfig: () => ({ provider: "deepseek", model: "deepseek-v4-flash", apiKey: "sk" }) as never,
      buildAgentTools,
    })) {
      events.push(event);
    }
    expect(events.some((e) => e.type === "error")).toBe(false);
  });
});

// Compaction is fired from a signal handler, which cannot yield into the run's event stream. Its
// cost used to be spent and then dropped; these pin the route that now carries it to the ledger.
describe("runAgent — compaction cost reaches the usage ledger", () => {
  const COMPACTION_USAGE = {
    inputTokensTotal: 40_000,
    inputTokensCacheRead: 0,
    inputTokensCacheWrite: 0,
    outputTokensTotal: 300,
    outputTokensReasoning: 0,
  };

  // Mirrors buildTools: the model it hands back reports through `deps.observe`, and the compaction
  // handler is what spends. The runner supplies the observer, so a double must accept one.
  function buildToolsThatCompacts(turns: Chunk[][], compactions = 1) {
    let turn = 0;
    const modelWithTools = {
      stream: async () => {
        const chunks = turns[turn++] ?? [];
        let accumulated: Chunk | null = null;
        return {
          chunks: (async function* () {
            for (const c of chunks) {
              accumulated = accumulated ? accumulated.concat(c) : c;
              yield c;
            }
          })(),
          accumulated: () => accumulated,
          usage: () => usageTokens(accumulated),
          emitted: () => accumulated !== null,
        };
      },
    };
    return ((_w: string, _d: string, _c: unknown, deps: { observe?: (r: unknown) => void }) => ({
      modelWithTools,
      model: modelWithTools,
      toolMap: { compact_context: { invoke: async () => "[Context compacted: hard.] Next step: go" } },
      signalHandlers: {
        compact_context: async () => {
          for (let i = 0; i < compactions; i++) {
            deps.observe?.({
              provider: "deepseek",
              model: "deepseek-v4-flash",
              stage: "compaction",
              usage: COMPACTION_USAGE,
              durationMs: 12,
              partial: false,
              emitted: true,
              concurrent: 1,
            });
          }
        },
      },
    })) as never;
  }

  const compactCallChunk = () =>
    new AIMessageChunk({
      content: "",
      tool_call_chunks: [
        {
          index: 0,
          id: "call_c1",
          name: "compact_context",
          args: '{"level":"hard","next_step":"go"}',
          type: "tool_call_chunk",
        },
      ],
    });

  async function runWithCompaction(compactions = 1): Promise<AgentEvent[]> {
    const events: AgentEvent[] = [];
    for await (const event of runAgent([], "do work", "/tmp/ws", "ws-1", {
      ...noopDeps,
      buildAgentTools: buildToolsThatCompacts(
        [[compactCallChunk()], [new AIMessageChunk({ content: "done" })]],
        compactions,
      ),
    })) {
      events.push(event);
    }
    return events;
  }

  const usageEvents = (events: AgentEvent[]) => events.filter((e) => e.type === "turn_usage");

  it("emits the summary request as its own usage row", async () => {
    const rows = usageEvents(await runWithCompaction());
    const compaction = rows.filter((r) => r.inputTokensTotal === COMPACTION_USAGE.inputTokensTotal);

    expect(compaction).toHaveLength(1);
    expect(compaction[0]).toMatchObject({ ...COMPACTION_USAGE, model: "deepseek-v4-flash", toolCalls: [] });
  });

  // A shared turnId would make the second row an update of the first, and the dashboard would show
  // one compaction where two were paid for.
  it("gives every compaction its own turn id, including the turn that triggered it", async () => {
    const rows = usageEvents(await runWithCompaction(2));
    const ids = rows.map((r) => r.turnId);
    expect(new Set(ids).size).toBe(ids.length);
    expect(rows.filter((r) => r.inputTokensTotal === COMPACTION_USAGE.inputTokensTotal)).toHaveLength(2);
  });

  it("leaves the triggering turn's own row untouched", async () => {
    const rows = usageEvents(await runWithCompaction());
    const toolTurn = rows.find((r) => r.toolCalls.some((tc) => tc.name === "compact_context"));

    expect(toolTurn).toBeDefined();
    expect(toolTurn!.inputTokensTotal).not.toBe(COMPACTION_USAGE.inputTokensTotal);
  });
});
