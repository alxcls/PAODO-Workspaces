// Reducer that folds streamed AgentEvents into chat-transcript bubbles: assistant/
// reasoning text upserts, tool start/result transitions, usage totals, and notices.

import { describe, it, expect } from "vitest";
import type { AgentEvent } from "@/lib/agent/runner";
import {
  type Message,
  type TranscriptState,
  emptyTranscript,
  applyDiscreteEvent,
  upsertAssistantText,
  upsertReasoningText,
  markAllToolsDone,
  appendDisconnected,
  clearDisconnected,
  toolLabel,
} from "./agentTranscript";

const state = (messages: Message[], totalInput = 0, totalOutput = 0): TranscriptState => ({
  messages,
  totalInput,
  totalOutput,
});

describe("markAllToolsDone", () => {
  // On abort, every still-spinning tool row is switched to done (no spinner left running).
  it("flips every open tool bubble to done (abort with no tool_result)", () => {
    const out = markAllToolsDone([
      { role: "tool_start", toolName: "execute_command", toolDone: false },
      { role: "tool_start", toolName: "file_read", toolDone: true },
    ]);
    expect(out.every((m) => m.role !== "tool_start" || m.toolDone)).toBe(true);
  });

  // Nothing open → returns the same array so React skips a needless re-render.
  it("returns the same array reference when nothing is open (idempotent)", () => {
    const messages: Message[] = [{ role: "tool_start", toolName: "glob", toolDone: true }];
    expect(markAllToolsDone(messages)).toBe(messages);
  });
});

describe("upsertAssistantText", () => {
  // First token with no open bubble creates a fresh assistant bubble.
  it("appends a new assistant bubble when none is open", () => {
    expect(upsertAssistantText([], "hi")).toEqual([{ role: "assistant", content: "hi" }]);
  });

  // Later tokens update the open bubble in place rather than stacking new ones.
  it("replaces the trailing open assistant bubble", () => {
    const out = upsertAssistantText([{ role: "assistant", content: "he" }], "hello");
    expect(out).toEqual([{ role: "assistant", content: "hello" }]);
  });

  // A new bubble starts after a thinking turn instead of overwriting the closed one.
  it("starts a fresh bubble when the last assistant turn is already thinking", () => {
    const out = upsertAssistantText([{ role: "assistant", content: "old", thinking: true }], "new");
    expect(out).toEqual([
      { role: "assistant", content: "old", thinking: true },
      { role: "assistant", content: "new" },
    ]);
  });
});

describe("upsertReasoningText", () => {
  // Reasoning tokens behave like assistant ones: create then update in place.
  it("appends then replaces the trailing reasoning bubble", () => {
    const first = upsertReasoningText([], "th");
    expect(first).toEqual([{ role: "reasoning", content: "th" }]);
    expect(upsertReasoningText(first, "think")).toEqual([{ role: "reasoning", content: "think" }]);
  });
});

describe("applyDiscreteEvent", () => {
  // Starting a tool closes the preceding assistant turn and adds a spinning tool row.
  it("tool_start collapses the prior assistant turn and appends a tool bubble", () => {
    const start = state([{ role: "assistant", content: "done reasoning" }]);
    const event: AgentEvent = { type: "tool_start", name: "file_read", args: { file_path: "a.ts" } };
    expect(applyDiscreteEvent(start, event).messages).toEqual([
      { role: "assistant", content: "done reasoning", thinking: true },
      { role: "tool_start", toolName: "file_read", toolSummary: "a.ts", toolDone: false },
    ]);
  });

  // With no assistant turn before it, the tool row is simply appended.
  it("tool_start without a prior assistant turn just appends", () => {
    const event: AgentEvent = { type: "tool_start", name: "glob", args: { pattern: "*.ts" } };
    expect(applyDiscreteEvent(emptyTranscript(), event).messages).toEqual([
      { role: "tool_start", toolName: "glob", toolSummary: "*.ts", toolDone: false },
    ]);
  });

  // A tool's result flips its matching row from spinning to done.
  it("tool_result flips the matching open tool bubble to done", () => {
    const start = state([{ role: "tool_start", toolName: "file_read", toolDone: false }]);
    const event: AgentEvent = { type: "tool_result", name: "file_read", result: "contents" };
    expect(applyDiscreteEvent(start, event).messages).toEqual([
      { role: "tool_start", toolName: "file_read", toolDone: true },
    ]);
  });

  // call_agent carries a deep-link (callee workspace + conversation) instead of an inline result;
  // other tools just mark done.
  it("tool_result attaches the callee session link only for call_agent", () => {
    const start = state([{ role: "tool_start", toolName: "call_agent", toolDone: false }]);
    const event: AgentEvent = {
      type: "tool_result",
      name: "call_agent",
      result: "sub-answer",
      meta: { conversationId: "conv-1", workspaceId: "ws-b", workspaceName: "Agent B" },
    };
    expect(applyDiscreteEvent(start, event).messages).toEqual([
      {
        role: "tool_start",
        toolName: "call_agent",
        toolDone: true,
        calleeWorkspaceId: "ws-b",
        calleeWorkspaceName: "Agent B",
        calleeConversationId: "conv-1",
      },
    ]);
  });

  // The link arrives mid-run via tool_link (the callee conversation was just created): the bubble
  // gains the deep-link but keeps spinning (toolDone stays false) until its tool_result lands.
  it("tool_link attaches the callee session link to the still-open call_agent bubble", () => {
    const start = state([{ role: "tool_start", toolName: "call_agent", toolDone: false }]);
    const event: AgentEvent = {
      type: "tool_link",
      name: "call_agent",
      meta: { conversationId: "conv-2", workspaceId: "ws-c", workspaceName: "Agent C" },
    };
    expect(applyDiscreteEvent(start, event).messages).toEqual([
      {
        role: "tool_start",
        toolName: "call_agent",
        toolDone: false,
        calleeWorkspaceId: "ws-c",
        calleeWorkspaceName: "Agent C",
        calleeConversationId: "conv-2",
      },
    ]);
  });

  // Two call_agent calls in the same turn open two bubbles that differ only by tool_call id —
  // each one's link and result must land on its own bubble, not both on the most recent.
  it("keeps parallel call_agent bubbles independent via the tool_call id", () => {
    let s = emptyTranscript();
    for (const [id, workspace] of [
      ["call-1", "Agent B"],
      ["call-2", "Agent C"],
    ]) {
      s = applyDiscreteEvent(s, { type: "tool_start", name: "call_agent", id, args: { workspace } });
    }
    s = applyDiscreteEvent(s, {
      type: "tool_link",
      name: "call_agent",
      id: "call-1",
      meta: { conversationId: "conv-b", workspaceId: "ws-b", workspaceName: "Agent B" },
    });
    s = applyDiscreteEvent(s, {
      type: "tool_link",
      name: "call_agent",
      id: "call-2",
      meta: { conversationId: "conv-c", workspaceId: "ws-c", workspaceName: "Agent C" },
    });

    expect(s.messages.map((m) => m.calleeConversationId)).toEqual(["conv-b", "conv-c"]);

    // The second call finishes first: only its bubble goes done, the first keeps spinning.
    s = applyDiscreteEvent(s, { type: "tool_result", name: "call_agent", id: "call-2", result: "ok" });
    expect(s.messages.map((m) => m.toolDone)).toEqual([false, true]);

    s = applyDiscreteEvent(s, { type: "tool_result", name: "call_agent", id: "call-1", result: "ok" });
    expect(s.messages.map((m) => m.toolDone)).toEqual([true, true]);
    expect(s.messages.map((m) => m.calleeConversationId)).toEqual(["conv-b", "conv-c"]);
  });

  // Providers that supply no tool_call id fall back to name matching, which cannot tell parallel
  // bubbles apart — but a link must still never overwrite a bubble that already has one.
  it("gives each parallel call_agent bubble a link even without tool_call ids", () => {
    let s = state([
      { role: "tool_start", toolName: "call_agent", toolDone: false },
      { role: "tool_start", toolName: "call_agent", toolDone: false },
    ]);
    for (const [conversationId, workspaceId] of [
      ["conv-b", "ws-b"],
      ["conv-c", "ws-c"],
    ]) {
      s = applyDiscreteEvent(s, {
        type: "tool_link",
        name: "call_agent",
        meta: { conversationId, workspaceId, workspaceName: workspaceId },
      });
    }
    expect(s.messages.map((m) => m.calleeConversationId).sort()).toEqual(["conv-b", "conv-c"]);
  });

  // Without meta (e.g. a pre-run rejection), the bubble just marks done — no link.
  it("tool_result without meta leaves a call_agent bubble linkless", () => {
    const start = state([{ role: "tool_start", toolName: "call_agent", toolDone: false }]);
    const event: AgentEvent = { type: "tool_result", name: "call_agent", result: "denied" };
    expect(applyDiscreteEvent(start, event).messages).toEqual([
      { role: "tool_start", toolName: "call_agent", toolDone: true },
    ]);
  });

  // Token usage from each turn adds onto the running input/output totals.
  it("turn_usage accumulates token totals", () => {
    const event: AgentEvent = {
      type: "turn_usage",
      inputTokens: 10,
      outputTokens: 4,
      reasoningTokens: 0,
      cachedInputTokens: 0,
      cacheCreationTokens: 0,
      toolCalls: [],
    };
    const once = applyDiscreteEvent(emptyTranscript(), event);
    expect([once.totalInput, once.totalOutput]).toEqual([10, 4]);
    const twice = applyDiscreteEvent(once, event);
    expect([twice.totalInput, twice.totalOutput]).toEqual([20, 8]);
  });

  // Finishing a turn drops a usage summary line above the last assistant answer.
  it("done inserts a usage line before the last completed assistant turn", () => {
    const start = state([{ role: "assistant", content: "answer" }], 12, 5);
    expect(applyDiscreteEvent(start, { type: "done" }).messages).toEqual([
      { role: "usage", inputTokens: 12, outputTokens: 5 },
      { role: "assistant", content: "answer" },
    ]);
  });

  // No tokens reported → no usage line is added.
  it("done is a no-op when no tokens were reported", () => {
    const start = state([{ role: "assistant", content: "answer" }]);
    expect(applyDiscreteEvent(start, { type: "done" }).messages).toEqual([{ role: "assistant", content: "answer" }]);
  });

  // Limit-reached and error events each append their own notice bubble.
  it("limit_reached and error append notices", () => {
    expect(applyDiscreteEvent(emptyTranscript(), { type: "limit_reached" }).messages).toEqual([
      { role: "limit_notice" },
    ]);
    expect(applyDiscreteEvent(emptyTranscript(), { type: "error", message: "boom" }).messages).toEqual([
      { role: "error", content: "boom" },
    ]);
  });
});

// A dropped viewer connection is transient: the run is server-owned and keeps going, so the notice
// has to survive repeated reconnect attempts without stacking, and disappear once resolved.
describe("disconnected notice", () => {
  it("appends a notice", () => {
    expect(appendDisconnected([{ role: "assistant", content: "hi" }])).toEqual([
      { role: "assistant", content: "hi" },
      { role: "disconnected" },
    ]);
  });

  // Each failed reconnect attempt re-appends; the transcript must not fill with notices.
  it("does not stack notices across repeated attempts", () => {
    let messages = appendDisconnected([{ role: "user", content: "go" }]);
    messages = appendDisconnected(messages);
    messages = appendDisconnected(messages);
    expect(messages.filter((m) => m.role === "disconnected")).toHaveLength(1);
  });

  // Only a trailing notice is the live one — an older notice mid-transcript (from an earlier drop
  // that recovered) must not suppress a new one.
  it("appends again when the notice is no longer the last message", () => {
    const recovered: Message[] = [{ role: "disconnected" }, { role: "assistant", content: "answer" }];
    expect(appendDisconnected(recovered).filter((m) => m.role === "disconnected")).toHaveLength(2);
  });

  it("clears every notice, leaving the rest untouched", () => {
    const messages: Message[] = [
      { role: "user", content: "go" },
      { role: "disconnected" },
      { role: "assistant", content: "answer" },
      { role: "disconnected" },
    ];
    expect(clearDisconnected(messages)).toEqual([
      { role: "user", content: "go" },
      { role: "assistant", content: "answer" },
    ]);
  });

  it("is a no-op on a transcript with no notices", () => {
    const messages: Message[] = [{ role: "assistant", content: "answer" }];
    expect(clearDisconnected(messages)).toEqual(messages);
  });
});

describe("toolLabel", () => {
  // Known tools get friendly labels; unknown ones fall back to a humanized name.
  it("maps known tools and humanizes unknown ones", () => {
    expect(toolLabel("file_read")).toBe("Reading file");
    expect(toolLabel("some_new_tool")).toBe("some new tool");
  });
});
