// runAgent must leave conversation history consistent when an aborted request
// abandons the streaming generator mid tool-call turn.

import { describe, it, expect } from "vitest";
import { AIMessage, AIMessageChunk, ToolMessage, type BaseMessage } from "@langchain/core/messages";
import { runAgent, classifyToolStatus, type AgentEvent } from "./runner";
import { buildSignalHandlers } from "./buildTools";

// runAgent mutates the conversation history (the messages array) in place. When a request is aborted
// (the user hits escape) the SSE consumer stops pulling and the generator is abandoned via
// `.return()` at whatever `yield` it is suspended on. The invariant these tests pin: at every
// such suspension point, history is either missing the whole tool-call turn or has it complete
// — never an AIMessage whose tool_calls lack their matching ToolMessages, which OpenAI rejects
// on the next request with "An assistant message with 'tool_calls' must be followed by tool
// messages". runAgent guarantees this by committing the AIMessage and all its ToolMessages in
// one synchronous block, so these tests fail if that commit is ever made non-atomic again.

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

// A fake model whose stream replays a scripted sequence of chunks per turn. Each turn either
// emits tool calls (with tool_call_chunks) or plain text (final answer).
function makeBuildTools(turns: Chunk[][], executeResult = "command ran") {
  let turn = 0;
  const modelWithTools = {
    stream: async (_messages: BaseMessage[], _opts: { signal?: AbortSignal }) => {
      const chunks = turns[turn++] ?? [];
      return (async function* () {
        for (const c of chunks) yield c;
      })();
    },
  };
  const toolMap = {
    execute_command: { invoke: async () => executeResult },
    workspace_restore: { invoke: async () => "[restoring]" },
  };
  return () => ({ modelWithTools, model: modelWithTools, toolMap, signalHandlers: {} }) as never;
}

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
  loadConfig: () => ({}) as never,
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

  it("persists a reasoning-model tool turn as coalesced text, not raw streamed blocks", async () => {
    const messages: BaseMessage[] = [];
    // A Claude/OpenAI extended-thinking chunk: content is an array of provider blocks (a signed
    // `thinking` block + a text block) alongside the tool call. Persisting this raw array froze
    // streaming-only blocks (`thinking`, `input_json_delta`) into history, which a later request
    // rejected with `unknown variant 'thinking', expected 'text'`. The tool turn must instead be
    // saved as the coalesced text string.
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

// Direct coverage of the production handlers (vs. only through runner dispatch). Pins the
// PostDispatchFn contract: each handler catches and logs its own errors so a side-effect failure
// never escapes into the run loop.
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
