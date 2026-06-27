import { describe, it, expect } from "vitest";
import { HumanMessage, AIMessage, ToolMessage, SystemMessage } from "@langchain/core/messages";
import {
  serializeMessages,
  deserializeMessages,
  setSystemPrompt,
  messagesToTranscript,
} from "./messageSerialization";

describe("message serialization round-trip", () => {
  it("preserves message classes, tool_calls and tool_call_id, dropping the system prompt", () => {
    const messages = [
      new SystemMessage("system prompt"),
      new HumanMessage("do the thing"),
      new AIMessage({ content: "calling", tool_calls: [{ id: "tc1", name: "file_read", args: { file_path: "a.txt" } }] }),
      new ToolMessage({ tool_call_id: "tc1", content: "file body" }),
      new AIMessage("done"),
    ];

    const stored = serializeMessages(messages);
    // System prompt is stripped before persistence.
    expect(stored).toHaveLength(4);

    const back = deserializeMessages(stored);
    expect(back.map((m) => m._getType())).toEqual(["human", "ai", "tool", "ai"]);
    expect((back[1] as AIMessage).tool_calls).toEqual([{ id: "tc1", name: "file_read", args: { file_path: "a.txt" } }]);
    expect((back[2] as ToolMessage).tool_call_id).toBe("tc1");
  });
});

describe("setSystemPrompt", () => {
  it("unshifts when no system prompt is present", () => {
    const msgs = [new HumanMessage("hi")];
    setSystemPrompt(msgs, new SystemMessage("sys"));
    expect(msgs.map((m) => m._getType())).toEqual(["system", "human"]);
  });
  it("replaces an existing leading system prompt without touching other messages", () => {
    const msgs = [new SystemMessage("old"), new HumanMessage("hi")];
    setSystemPrompt(msgs, new SystemMessage("new"));
    expect(msgs).toHaveLength(2);
    expect(msgs[0].content).toBe("new");
    expect(msgs[1].content).toBe("hi");
  });
});

describe("messagesToTranscript", () => {
  it("projects a history into the client transcript shape", () => {
    const messages = [
      new HumanMessage("read a file"),
      new AIMessage({ content: "let me look", tool_calls: [{ id: "t1", name: "file_read", args: { file_path: "a.txt" } }] }),
      new ToolMessage({ tool_call_id: "t1", content: "secret" }),
      new AIMessage("here is the answer"),
    ];

    const t = messagesToTranscript(messages);
    expect(t[0]).toEqual({ role: "user", content: "read a file" });
    // The preamble alongside a tool call renders as collapsed "thinking".
    expect(t[1]).toMatchObject({ role: "assistant", content: "let me look", thinking: true });
    // Historical tool bubbles are already done; non-call_agent results are not surfaced inline.
    expect(t[2]).toMatchObject({ role: "tool_start", toolName: "file_read", toolDone: true });
    expect(t[2].calleeConversationId).toBeUndefined();
    expect(t[3]).toEqual({ role: "assistant", content: "here is the answer" });
  });

  it("replays the run-cumulative usage line before the terminal assistant bubble", () => {
    const messages = [
      new HumanMessage("hi"),
      new AIMessage({ content: "answer", response_metadata: { runUsage: { inputTokens: 1200, outputTokens: 340 } } }),
    ];
    const t = messagesToTranscript(messages);
    expect(t[0]).toEqual({ role: "user", content: "hi" });
    expect(t[1]).toEqual({ role: "usage", inputTokens: 1200, outputTokens: 340 });
    expect(t[2]).toEqual({ role: "assistant", content: "answer" });
  });

  it("emits no usage line when runUsage is absent or zero", () => {
    const messages = [
      new AIMessage("no usage"),
      new AIMessage({ content: "zero usage", response_metadata: { runUsage: { inputTokens: 0, outputTokens: 0 } } }),
    ];
    const t = messagesToTranscript(messages);
    expect(t.every((m) => m.role !== "usage")).toBe(true);
  });

  it("preserves response_metadata.runUsage across a serialize round-trip", () => {
    const messages = [new AIMessage({ content: "answer", response_metadata: { runUsage: { inputTokens: 5, outputTokens: 6 } } })];
    const back = deserializeMessages(serializeMessages(messages));
    const t = messagesToTranscript(back);
    expect(t[0]).toEqual({ role: "usage", inputTokens: 5, outputTokens: 6 });
  });

  it("rebuilds the call_agent session deep-link from the ToolMessage's additional_kwargs", () => {
    const messages = [
      new AIMessage({ content: "", tool_calls: [{ id: "c1", name: "call_agent", args: { workspace: "b" } }] }),
      new ToolMessage({
        tool_call_id: "c1",
        content: "neighbor reply",
        additional_kwargs: { calleeConversationId: "conv-9", calleeWorkspaceId: "ws-b", calleeWorkspaceName: "Agent B" },
      }),
    ];
    const t = messagesToTranscript(messages);
    expect(t[0]).toMatchObject({
      role: "tool_start",
      toolName: "call_agent",
      calleeConversationId: "conv-9",
      calleeWorkspaceId: "ws-b",
      calleeWorkspaceName: "Agent B",
    });
  });

  it("omits the link for a call_agent ToolMessage with no persisted meta", () => {
    const messages = [
      new AIMessage({ content: "", tool_calls: [{ id: "c1", name: "call_agent", args: { workspace: "b" } }] }),
      new ToolMessage({ tool_call_id: "c1", content: "neighbor reply" }),
    ];
    const t = messagesToTranscript(messages);
    expect(t[0]).toMatchObject({ role: "tool_start", toolName: "call_agent", toolDone: true });
    expect(t[0].calleeConversationId).toBeUndefined();
  });
});
