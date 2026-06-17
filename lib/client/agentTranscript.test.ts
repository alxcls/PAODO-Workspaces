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
  toolLabel,
} from "./agentTranscript";

const state = (messages: Message[], totalInput = 0, totalOutput = 0): TranscriptState => ({ messages, totalInput, totalOutput });

describe("upsertAssistantText", () => {
  it("appends a new assistant bubble when none is open", () => {
    expect(upsertAssistantText([], "hi")).toEqual([{ role: "assistant", content: "hi" }]);
  });

  it("replaces the trailing open assistant bubble", () => {
    const out = upsertAssistantText([{ role: "assistant", content: "he" }], "hello");
    expect(out).toEqual([{ role: "assistant", content: "hello" }]);
  });

  it("starts a fresh bubble when the last assistant turn is already thinking", () => {
    const out = upsertAssistantText([{ role: "assistant", content: "old", thinking: true }], "new");
    expect(out).toEqual([
      { role: "assistant", content: "old", thinking: true },
      { role: "assistant", content: "new" },
    ]);
  });
});

describe("upsertReasoningText", () => {
  it("appends then replaces the trailing reasoning bubble", () => {
    const first = upsertReasoningText([], "th");
    expect(first).toEqual([{ role: "reasoning", content: "th" }]);
    expect(upsertReasoningText(first, "think")).toEqual([{ role: "reasoning", content: "think" }]);
  });
});

describe("applyDiscreteEvent", () => {
  it("tool_start collapses the prior assistant turn and appends a tool bubble", () => {
    const start = state([{ role: "assistant", content: "done reasoning" }]);
    const event: AgentEvent = { type: "tool_start", name: "file_read", args: { file_path: "a.ts" } };
    expect(applyDiscreteEvent(start, event).messages).toEqual([
      { role: "assistant", content: "done reasoning", thinking: true },
      { role: "tool_start", toolName: "file_read", toolSummary: "a.ts", toolDone: false },
    ]);
  });

  it("tool_start without a prior assistant turn just appends", () => {
    const event: AgentEvent = { type: "tool_start", name: "glob", args: { pattern: "*.ts" } };
    expect(applyDiscreteEvent(emptyTranscript(), event).messages).toEqual([
      { role: "tool_start", toolName: "glob", toolSummary: "*.ts", toolDone: false },
    ]);
  });

  it("tool_result flips the matching open tool bubble to done", () => {
    const start = state([{ role: "tool_start", toolName: "file_read", toolDone: false }]);
    const event: AgentEvent = { type: "tool_result", name: "file_read", result: "contents" };
    expect(applyDiscreteEvent(start, event).messages).toEqual([
      { role: "tool_start", toolName: "file_read", toolDone: true },
    ]);
  });

  it("tool_result attaches the result only for call_agent", () => {
    const start = state([{ role: "tool_start", toolName: "call_agent", toolDone: false }]);
    const event: AgentEvent = { type: "tool_result", name: "call_agent", result: "sub-answer" };
    expect(applyDiscreteEvent(start, event).messages).toEqual([
      { role: "tool_start", toolName: "call_agent", toolDone: true, toolResult: "sub-answer" },
    ]);
  });

  it("turn_usage accumulates token totals", () => {
    const event: AgentEvent = {
      type: "turn_usage", inputTokens: 10, outputTokens: 4,
      reasoningTokens: 0, cachedInputTokens: 0, cacheCreationTokens: 0, toolCalls: [],
    };
    const once = applyDiscreteEvent(emptyTranscript(), event);
    expect([once.totalInput, once.totalOutput]).toEqual([10, 4]);
    const twice = applyDiscreteEvent(once, event);
    expect([twice.totalInput, twice.totalOutput]).toEqual([20, 8]);
  });

  it("done inserts a usage line before the last completed assistant turn", () => {
    const start = state([{ role: "assistant", content: "answer" }], 12, 5);
    expect(applyDiscreteEvent(start, { type: "done" }).messages).toEqual([
      { role: "usage", inputTokens: 12, outputTokens: 5 },
      { role: "assistant", content: "answer" },
    ]);
  });

  it("done is a no-op when no tokens were reported", () => {
    const start = state([{ role: "assistant", content: "answer" }]);
    expect(applyDiscreteEvent(start, { type: "done" }).messages).toEqual([{ role: "assistant", content: "answer" }]);
  });

  it("limit_reached and error append notices", () => {
    expect(applyDiscreteEvent(emptyTranscript(), { type: "limit_reached" }).messages).toEqual([{ role: "limit_notice" }]);
    expect(applyDiscreteEvent(emptyTranscript(), { type: "error", message: "boom" }).messages).toEqual([
      { role: "error", content: "boom" },
    ]);
  });
});

describe("toolLabel", () => {
  it("maps known tools and humanizes unknown ones", () => {
    expect(toolLabel("file_read")).toBe("Reading file");
    expect(toolLabel("some_new_tool")).toBe("some new tool");
  });
});
