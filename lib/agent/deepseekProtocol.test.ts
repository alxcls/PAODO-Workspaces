import { describe, expect, it, vi } from "vitest";
import { AIMessage, HumanMessage, ToolMessage, type BaseMessage } from "@langchain/core/messages";
import { createDeepSeekChatModel, deepseekReasoningConfig, prepareDeepSeekMessages } from "./deepseekProtocol";
import { deserializeMessages, serializeMessages } from "./messageSerialization";
import { withReplayMetadata } from "./reasoningReplay";

function thinkingTurn(id: string, reasoning: string): BaseMessage[] {
  return [
    new AIMessage({
      content: "Let me look.",
      tool_calls: [{ id, name: "file_read", args: {} }],
      response_metadata: withReplayMetadata({ executionTurnId: "turn-1" }, reasoning),
    }),
    new ToolMessage({ tool_call_id: id, content: "result" }),
  ];
}

/**
 * A model whose captured fetch never reaches the network. Driving a real client is the point: the
 * injection rides the request body LangChain builds, so a change in how it builds one must fail here
 * rather than silently stop replaying reasoning.
 */
function modelWithCapturedRequest() {
  const seen: { body?: string } = {};
  const fetchStub = vi.fn(async (_input: unknown, init?: { body?: unknown }) => {
    seen.body = typeof init?.body === "string" ? init.body : undefined;
    return new Response(JSON.stringify({ id: "1", choices: [{ message: { role: "assistant", content: "ok" } }] }), {
      headers: { "content-type": "application/json" },
    });
  });
  const model = createDeepSeekChatModel({
    model: "deepseek-v4-pro",
    maxRetries: 0,
    configuration: { baseURL: "https://api.deepseek.com/v1", apiKey: "k", fetch: fetchStub as never },
  });
  return { model, seen };
}

async function sentMessages(messages: BaseMessage[]): Promise<Array<Record<string, unknown>>> {
  const { model, seen } = modelWithCapturedRequest();
  await model.invoke(prepareDeepSeekMessages(messages, model));
  return JSON.parse(seen.body ?? "{}").messages ?? [];
}

describe("deepseekReasoningConfig", () => {
  it.each([
    ["low", { reasoning_effort: "low" }],
    ["max", { reasoning_effort: "max" }],
  ])("sends effort %s as reasoning_effort", (effort, expected) => {
    expect(deepseekReasoningConfig(effort as never).modelKwargs).toEqual(expected);
  });

  // reasoning_effort has no "none" in the OpenAI-compatible API, so off is a different field entirely.
  it("switches thinking off with the thinking field, never an effort level", () => {
    expect(deepseekReasoningConfig("none").modelKwargs).toEqual({ thinking: { type: "disabled" } });
  });
});

describe("prepareDeepSeekMessages", () => {
  it("replays the stored reasoning on the assistant turn that called the tool", async () => {
    const sent = await sentMessages(thinkingTurn("call_a", "I should read the file first."));

    const assistant = sent.find((m) => Array.isArray(m.tool_calls));
    expect(assistant?.reasoning_content).toBe("I should read the file first.");
  });

  it("pairs reasoning by tool-call id, not by position", async () => {
    const messages = [
      new HumanMessage("go"),
      ...thinkingTurn("call_a", "First thought."),
      ...thinkingTurn("call_b", "Second thought."),
    ];

    const sent = await sentMessages(messages);
    const assistants = sent.filter((m) => Array.isArray(m.tool_calls));

    expect(assistants[0]?.reasoning_content).toBe("First thought.");
    expect(assistants[1]?.reasoning_content).toBe("Second thought.");
  });

  it("survives durable serialization, so a reopened conversation still replays", async () => {
    const restored = deserializeMessages(serializeMessages(thinkingTurn("call_a", "Persisted thought.")));

    const sent = await sentMessages(restored);

    expect(sent.find((m) => Array.isArray(m.tool_calls))?.reasoning_content).toBe("Persisted thought.");
  });

  it("leaves a turn that stored no reasoning untouched", async () => {
    const messages = [
      new AIMessage({ content: "Looking.", tool_calls: [{ id: "call_a", name: "file_read", args: {} }] }),
      new ToolMessage({ tool_call_id: "call_a", content: "result" }),
    ];

    const sent = await sentMessages(messages);

    expect(sent.find((m) => Array.isArray(m.tool_calls))).not.toHaveProperty("reasoning_content");
  });

  it("returns the caller's own array, leaving canonical history unrewritten", () => {
    const { model } = modelWithCapturedRequest();
    const messages = thinkingTurn("call_a", "Private thought.");

    const outbound = prepareDeepSeekMessages(messages, model);

    expect(outbound).toBe(messages);
    expect(outbound[0]).toBe(messages[0]);
    expect((messages[0] as AIMessage).content).toBe("Let me look.");
  });
});
