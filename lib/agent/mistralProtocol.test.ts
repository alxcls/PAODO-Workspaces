import { describe, expect, it, vi } from "vitest";
import { AIMessage, HumanMessage, ToolMessage, type AIMessageChunk, type BaseMessage } from "@langchain/core/messages";
import { deserializeMessages, serializeMessages } from "./messageSerialization";
import {
  createMistralChatModel,
  flattenMistralDelta,
  mistralReplayContent,
  mistralThinkingText,
  prepareMistralMessages,
  withMistralReplayMetadata,
} from "./mistralProtocol";

function toolPair(id: string, name = "file_read"): BaseMessage[] {
  return [
    new AIMessage({ content: "calling", tool_calls: [{ id, name, args: {} }] }),
    new ToolMessage({ tool_call_id: id, content: "result" }),
  ];
}

describe("prepareMistralMessages", () => {
  it("translates foreign tool ids on an outbound clone without changing canonical history", () => {
    const nativeId = "toolu_01A09q9rDJmwvLpPCJKtxpvB";
    const messages = toolPair(nativeId);

    const first = prepareMistralMessages(messages);
    const second = prepareMistralMessages(messages);
    const translated = (first[0] as AIMessage).tool_calls![0].id!;

    expect(translated).toMatch(/^[A-Za-z0-9]{9}$/);
    expect((first[1] as ToolMessage).tool_call_id).toBe(translated);
    expect((second[0] as AIMessage).tool_calls![0].id).toBe(translated);
    expect((messages[0] as AIMessage).tool_calls![0].id).toBe(nativeId);
    expect((messages[1] as ToolMessage).tool_call_id).toBe(nativeId);
    expect(first[0]).not.toBe(messages[0]);
    expect(first[1]).not.toBe(messages[1]);
  });

  it("keeps parallel calls distinct, paired, and stable", () => {
    const messages: BaseMessage[] = [
      new AIMessage({
        content: "",
        tool_calls: [
          { id: "call_openai_a", name: "glob", args: {} },
          { id: "toolu_anthropic_b", name: "file_read", args: {} },
        ],
      }),
      new ToolMessage({ tool_call_id: "call_openai_a", content: "a" }),
      new ToolMessage({ tool_call_id: "toolu_anthropic_b", content: "b" }),
    ];

    const outbound = prepareMistralMessages(messages);
    const ids = (outbound[0] as AIMessage).tool_calls!.map((call) => call.id!);

    expect(new Set(ids).size).toBe(2);
    expect((outbound[1] as ToolMessage).tool_call_id).toBe(ids[0]);
    expect((outbound[2] as ToolMessage).tool_call_id).toBe(ids[1]);
    expect(
      prepareMistralMessages(messages).map((message) =>
        message instanceof ToolMessage ? message.tool_call_id : undefined,
      ),
    ).toEqual([undefined, ids[0], ids[1]]);
  });

  it("is a no-op when no Mistral-specific adaptation is needed", () => {
    const messages: BaseMessage[] = [new HumanMessage("hi"), ...toolPair("abc123XYZ")];
    const outbound = prepareMistralMessages(messages);

    expect(outbound).not.toBe(messages);
    expect(outbound[0]).toBe(messages[0]);
    expect(outbound[1]).toBe(messages[1]);
    expect(outbound[2]).toBe(messages[2]);
  });

  it("restores saved ThinkChunk content only on the outbound assistant clone", () => {
    const replay = mistralReplayContent("I should inspect first.", "I will inspect it.");
    const canonical = new AIMessage({
      content: "I will inspect it.",
      response_metadata: withMistralReplayMetadata({ executionTurnId: "turn-1" }, replay),
    });

    const outbound = prepareMistralMessages([canonical])[0] as AIMessage;

    expect(canonical.content).toBe("I will inspect it.");
    expect(outbound.content).toEqual(replay);
    expect(outbound).not.toBe(canonical);
    expect(outbound.response_metadata.executionTurnId).toBe("turn-1");
  });

  it("retains private replay state through durable message serialization", () => {
    const replay = mistralReplayContent("Plan privately.", "Act publicly.");
    const canonical = new AIMessage({
      content: "Act publicly.",
      response_metadata: withMistralReplayMetadata({}, replay),
    });

    const restored = deserializeMessages(serializeMessages([canonical]));
    const outbound = prepareMistralMessages(restored)[0] as AIMessage;

    expect(restored[0].content).toBe("Act publicly.");
    expect(outbound.content).toEqual(replay);
  });
});

describe("mistralThinkingText", () => {
  it("joins Mistral's nested text chunks", () => {
    expect(
      mistralThinkingText([
        { type: "text", text: "I should " },
        { type: "text", text: "inspect." },
      ]),
    ).toBe("I should inspect.");
  });

  it("ignores unknown nested data safely", () => {
    expect(mistralThinkingText([{ type: "image", url: "x" }, null, { text: 42 }])).toBe("");
  });
});

describe("flattenMistralDelta", () => {
  it("splits Mistral's content blocks into prose and reasoning", () => {
    expect(
      flattenMistralDelta({
        content: [
          { type: "thinking", thinking: [{ type: "text", text: "weighing it" }] },
          { type: "text", text: "Here goes." },
        ],
      }),
    ).toEqual({ content: "Here goes.", reasoning_content: "weighing it" });
  });

  // A model with no reasoning still blocks its prose. Nothing here is reasoning-specific: it is the
  // array that the completions path discards, and there the dropped tokens are the answer itself.
  it("joins a text-only block array without inventing reasoning", () => {
    const flat = flattenMistralDelta({
      content: [
        { type: "text", text: "def " },
        { type: "text", text: "main():" },
      ],
    });
    expect(flat).toEqual({ content: "def main():" });
    expect(flat).not.toHaveProperty("reasoning_content");
  });

  it("leaves a plain string delta and its tool calls untouched", () => {
    const delta = { content: "hi", tool_calls: [{ index: 0, id: "abc" }] };
    expect(flattenMistralDelta(delta)).toBe(delta);
  });
});

// Driven through a real model instance rather than the subclass alone: the hook it overrides is
// deprecated upstream, and once removed the override would sit there passing while every reasoning
// delta is dropped again — the failure this whole seam exists to prevent.
describe("createMistralChatModel", () => {
  function sseResponse(events: object[]): Response {
    const body = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n";
    return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
  }

  function delta(content: unknown) {
    return {
      id: "cmpl-1",
      object: "chat.completion.chunk",
      created: 0,
      model: "mistral-medium-latest",
      choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason: null }],
    };
  }

  it("streams reasoning blocks instead of discarding them with a console warning", async () => {
    const warn = vi.spyOn(console, "log").mockImplementation(() => {});
    const model = createMistralChatModel({
      model: "mistral-medium-latest",
      configuration: {
        baseURL: "https://api.mistral.ai/v1",
        apiKey: "key-mistral",
        fetch: async () =>
          sseResponse([
            delta([{ type: "thinking", thinking: [{ type: "text", text: "weighing it" }] }]),
            delta("Here goes."),
          ]),
      },
    });

    const chunks: AIMessageChunk[] = [];
    for await (const chunk of await model.stream([new HumanMessage("hi")])) chunks.push(chunk);

    expect(chunks.map((c) => c.additional_kwargs.reasoning_content).filter(Boolean)).toEqual(["weighing it"]);
    expect(chunks.map((c) => c.content).join("")).toBe("Here goes.");
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("streams prose that arrives as blocks, which a non-reasoning model loses outright", async () => {
    const warn = vi.spyOn(console, "log").mockImplementation(() => {});
    const model = createMistralChatModel({
      model: "codestral-latest",
      configuration: {
        baseURL: "https://api.mistral.ai/v1",
        apiKey: "key-mistral",
        fetch: async () =>
          sseResponse([delta([{ type: "text", text: "def " }]), delta([{ type: "text", text: "main():" }])]),
      },
    });

    const chunks: AIMessageChunk[] = [];
    for await (const chunk of await model.stream([new HumanMessage("hi")])) chunks.push(chunk);

    expect(chunks.map((c) => c.content).join("")).toBe("def main():");
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});
