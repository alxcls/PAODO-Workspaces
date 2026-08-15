import { describe, expect, it } from "vitest";
import { AIMessage, HumanMessage, ToolMessage, type BaseMessage } from "@langchain/core/messages";
import { deserializeMessages, serializeMessages } from "./messageSerialization";
import {
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
