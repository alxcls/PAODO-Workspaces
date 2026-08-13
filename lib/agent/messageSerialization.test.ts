import { describe, it, expect } from "vitest";
import { HumanMessage, AIMessage, ToolMessage, SystemMessage } from "@langchain/core/messages";
import {
  serializeMessages,
  deserializeMessages,
  setSystemPrompt,
  messagesToTranscript,
  noteRunError,
} from "./messageSerialization";

describe("message serialization round-trip", () => {
  it("preserves message classes, tool_calls and tool_call_id, dropping the system prompt", () => {
    const messages = [
      new SystemMessage("system prompt"),
      new HumanMessage("do the thing"),
      new AIMessage({
        content: "calling",
        tool_calls: [{ id: "tc1", name: "file_read", args: { file_path: "a.txt" } }],
      }),
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
      new AIMessage({
        content: "let me look",
        tool_calls: [{ id: "t1", name: "file_read", args: { file_path: "a.txt" } }],
      }),
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

  it("joins per-turn tokens without storing their values in conversation messages", () => {
    const messages = [
      new AIMessage({
        content: "I will inspect it",
        tool_calls: [{ id: "t1", name: "file_read", args: { file_path: "a.txt" } }],
        response_metadata: { executionTurnId: "turn-tool" },
      }),
      new ToolMessage({ tool_call_id: "t1", content: "body" }),
      new AIMessage({ content: "Done", response_metadata: { executionTurnId: "turn-final" } }),
    ];
    const back = deserializeMessages(serializeMessages(messages));
    const transcript = messagesToTranscript(
      back,
      new Map([
        [
          "turn-final",
          {
            inputTokensTotal: 250,
            inputTokensCacheRead: 100,
            outputTokensTotal: 30,
          },
        ],
      ]),
    );

    expect(transcript.filter((message) => message.role === "usage")).toEqual([
      {
        role: "usage",
        inputTokensTotal: 250,
        inputTokensCacheRead: 100,
        outputTokensTotal: 30,
      },
    ]);
    expect(transcript.map((message) => message.role)).toEqual(["assistant", "tool_start", "usage", "assistant"]);
    expect(JSON.stringify(serializeMessages(messages))).not.toContain("inputTokens");
  });

  it("rebuilds the call_agent session deep-link from the ToolMessage's additional_kwargs", () => {
    const messages = [
      new AIMessage({ content: "", tool_calls: [{ id: "c1", name: "call_agent", args: { workspace: "b" } }] }),
      new ToolMessage({
        tool_call_id: "c1",
        content: "neighbor reply",
        additional_kwargs: {
          calleeConversationId: "conv-9",
          calleeWorkspaceId: "ws-b",
          calleeWorkspaceName: "Agent B",
        },
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

describe("run errors on the persisted history", () => {
  it("shows why the run stopped when the conversation is re-opened", () => {
    // The failing run's own history: the prompt landed, one tool turn ran, then the provider
    // refused. Live, the reason exists only as a stream event — this is what a reload has to work
    // from, and before it was recorded the conversation re-opened as a prompt with no reply.
    const messages = [
      new HumanMessage("audit the data"),
      new AIMessage({ content: "", tool_calls: [{ id: "t1", name: "file_read", args: { file_path: "a.json" } }] }),
      new ToolMessage({ tool_call_id: "t1", content: "{}" }),
    ];
    noteRunError(messages, "The deepseek account has run out of credit, so deepseek-chat refused the request.");

    const t = messagesToTranscript(deserializeMessages(serializeMessages(messages)));

    // Last, after the work that did happen — not floated up next to the prompt.
    expect(t.at(-1)).toEqual({
      role: "error",
      content: "The deepseek account has run out of credit, so deepseek-chat refused the request.",
    });
    expect(t.filter((m) => m.role === "error")).toHaveLength(1);
  });

  it("leaves a clean history untouched and ignores an empty note", () => {
    expect(messagesToTranscript([new HumanMessage("hi"), new AIMessage("hello")]).some((m) => m.role === "error")).toBe(
      false,
    );
    // Nothing to attach to: a run that failed before any message was committed.
    expect(() => noteRunError([], "boom")).not.toThrow();
  });
});
