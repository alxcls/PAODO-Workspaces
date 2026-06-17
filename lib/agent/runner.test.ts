// runAgent must leave conversation history consistent when an aborted request
// abandons the streaming generator mid tool-call turn.

import { describe, it, expect } from "vitest";
import { AIMessage, AIMessageChunk, ToolMessage, type BaseMessage } from "@langchain/core/messages";
import { runAgent, classifyToolStatus, type AgentEvent } from "./runner";

// runAgent mutates the conversation history (ws.messages) in place. When a request is aborted
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
      messages.slice(i + 1).filter((t): t is ToolMessage => t instanceof ToolMessage).map((t) => t.tool_call_id),
    );
    return !m.tool_calls.every((tc) => tc.id && answered.has(tc.id));
  });
}

// A fake model whose stream replays a scripted sequence of chunks per turn. Each turn either
// emits tool calls (with tool_call_chunks) or plain text (final answer).
function makeBuildTools(turns: Chunk[][]) {
  let turn = 0;
  const modelWithTools = {
    stream: async (_messages: BaseMessage[], _opts: { signal?: AbortSignal }) => {
      const chunks = turns[turn++] ?? [];
      return (async function* () {
        for (const c of chunks) yield c;
      })();
    },
  };
  const toolMap = { execute_command: { invoke: async () => "command ran" } };
  return () => ({ modelWithTools, model: modelWithTools, toolMap }) as never;
}

// One chunk carrying one or more tool calls (each a distinct execute_command so dedup keeps all).
function toolCallsChunk(...calls: { id: string; args: string }[]): Chunk {
  return new AIMessageChunk({
    content: "",
    tool_call_chunks: calls.map((c, index) => ({ index, id: c.id, name: "execute_command", args: c.args, type: "tool_call_chunk" })),
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
    for await (const event of runAgent(messages, "run the server", "/tmp/ws", "ws-1", { ...noopDeps, buildAgentTools })) {
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
    for await (const event of runAgent(messages, "do two things", "/tmp/ws", "ws-1", { ...noopDeps, buildAgentTools })) {
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
});

describe("classifyToolStatus", () => {
  it("classifies success, the Error/Permission-denied convention, and the A2A needs-input tag", () => {
    expect(classifyToolStatus("line1\nline2")).toBe("ok");
    expect(classifyToolStatus("Command executed successfully with no output.")).toBe("ok");
    expect(classifyToolStatus("Error: command exited with code 1\nbuild failed")).toBe("error");
    expect(classifyToolStatus('Error (INPUT_VALIDATION_ERROR): missing field')).toBe("error");
    expect(classifyToolStatus("Error: unknown tool \"foo\"")).toBe("error");
    expect(classifyToolStatus("Permission denied: not connected")).toBe("error");
    expect(classifyToolStatus('Needs input: the target agent needs different input: "which warehouse?"')).toBe("needs_input");
  });
});
