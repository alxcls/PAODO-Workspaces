import { describe, expect, it, vi } from "vitest";
import { AIMessage, HumanMessage, ToolMessage, type BaseMessage } from "@langchain/core/messages";
import { createDeepSeekChatModel, deepseekReasoningConfig } from "./deepseekProtocol";
import { deserializeMessages, serializeMessages } from "./messageSerialization";
import { createModelGateway } from "./modelGateway";
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
 * A gateway whose captured fetch never reaches the network.
 *
 * Built through createModelGateway rather than around a bare client, because the object the runner
 * calls is the one bindTools returns — a different object wrapping the same client. Replay that works
 * on the client alone and not through here is replay that never runs in production.
 */
function gatewayWithCapturedRequest() {
  const seen: { body?: string } = {};
  const fetchStub = vi.fn(async (_input: unknown, init?: { body?: unknown }) => {
    seen.body = typeof init?.body === "string" ? init.body : undefined;
    return new Response(JSON.stringify({ id: "1", choices: [{ message: { role: "assistant", content: "ok" } }] }), {
      headers: { "content-type": "application/json" },
    });
  });
  const chat = createDeepSeekChatModel({
    model: "deepseek-v4-pro",
    maxRetries: 0,
    configuration: { baseURL: "https://api.deepseek.com/v1", apiKey: "k", fetch: fetchStub as never },
  });
  const gateway = createModelGateway(chat as never, { provider: "deepseek", model: "deepseek-v4-pro" });
  return { gateway, seen };
}

const CALL = { stage: "model_turn" } as never;

/** What the runner sends: through the tool-bound gateway, which is not the client we constructed. */
async function sentMessages(messages: BaseMessage[]): Promise<Array<Record<string, unknown>>> {
  const { gateway, seen } = gatewayWithCapturedRequest();
  await gateway.bindTools([]).invoke(messages, CALL);
  return JSON.parse(seen.body ?? "{}").messages ?? [];
}

function assistantWithTools(sent: Array<Record<string, unknown>>) {
  return sent.find((m) => Array.isArray(m.tool_calls));
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

describe("deepseek reasoning replay", () => {
  it("replays the stored reasoning on the assistant turn that called the tool", async () => {
    const sent = await sentMessages(thinkingTurn("call_a", "I should read the file first."));

    expect(assistantWithTools(sent)?.reasoning_content).toBe("I should read the file first.");
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

    expect(assistantWithTools(sent)?.reasoning_content).toBe("Persisted thought.");
  });

  it("leaves a turn that stored no reasoning untouched", async () => {
    const messages = [
      new AIMessage({ content: "Looking.", tool_calls: [{ id: "call_a", name: "file_read", args: {} }] }),
      new ToolMessage({ tool_call_id: "call_a", content: "result" }),
    ];

    const sent = await sentMessages(messages);

    expect(assistantWithTools(sent)).not.toHaveProperty("reasoning_content");
  });

  // The reasoning reaches the wire without ever being written onto the message it came from.
  it("leaves canonical history unrewritten", async () => {
    const messages = thinkingTurn("call_a", "Private thought.");
    const [assistant] = messages;

    const sent = await sentMessages(messages);

    expect(assistantWithTools(sent)?.reasoning_content).toBe("Private thought.");
    expect(messages[0]).toBe(assistant);
    expect((messages[0] as AIMessage).content).toBe("Let me look.");
    expect((messages[0] as AIMessage).additional_kwargs).not.toHaveProperty("reasoning_content");
  });

  // The turn loop streams; only compaction and limit synthesis invoke. A scope that closed before the
  // request left would replay on one path and not the other.
  it("replays on the streaming path the agent loop actually uses", async () => {
    const { gateway, seen } = gatewayWithCapturedRequest();

    const stream = await gateway.bindTools([]).stream(thinkingTurn("call_a", "Streamed thought."), CALL);
    for await (const _chunk of stream.chunks) void _chunk;

    const sent = JSON.parse(seen.body ?? "{}").messages ?? [];
    expect(assistantWithTools(sent)?.reasoning_content).toBe("Streamed thought.");
  });

  /**
   * The bug this guards: the lookup used to live on the client, which the tool-bound gateway shares
   * with the unbound one. A call that resolved could leave entries behind for a later call that had
   * no business seeing them, so the scope has to close with the request that opened it.
   */
  it("does not carry one call's reasoning into the next", async () => {
    const { gateway, seen } = gatewayWithCapturedRequest();

    await gateway.invoke(thinkingTurn("call_a", "Thought from an earlier call."), CALL);
    await gateway.bindTools([]).invoke(
      [new AIMessage({ content: "Looking.", tool_calls: [{ id: "call_a", name: "file_read", args: {} }] })],
      CALL,
    );

    const sent = JSON.parse(seen.body ?? "{}").messages ?? [];
    expect(assistantWithTools(sent)).not.toHaveProperty("reasoning_content");
  });
});
