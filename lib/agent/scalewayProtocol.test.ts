import { describe, expect, it } from "vitest";
import { HumanMessage, type AIMessageChunk } from "@langchain/core/messages";
import {
  createScalewayChatModel,
  renameScalewayReasoning,
  scalewayEffort,
  scalewayReasoningConfig,
} from "./scalewayProtocol";

describe("scalewayEffort", () => {
  it("passes through a level the model documents", () => {
    expect(scalewayEffort("deepseek-v4-flash-0731", "high")).toBe("high");
    expect(scalewayEffort("qwen3.6-35b-a3b", "medium")).toBe("medium");
  });

  /**
   * The bug this closes: Scaleway validates reasoning_effort against vLLM's whole union, so "low" on
   * a model that only knows none|medium is accepted, silently treated as its default, and billed as
   * reasoning. Sending the default outright makes the request say what actually happens.
   */
  it("replaces a level the model does not document with that model's own default", () => {
    expect(scalewayEffort("qwen3.6-35b-a3b", "low")).toBe("medium");
    expect(scalewayEffort("qwen3.6-35b-a3b", "high")).toBe("medium");
    expect(scalewayEffort("deepseek-v4-flash-0731", "medium")).toBe("high");
  });

  // Thinking off is a stored toggle state, not a level to approximate — snapping it to a default
  // would bill every turn of a workspace that switched reasoning off.
  it("never turns thinking back on", () => {
    expect(scalewayEffort("qwen3.6-35b-a3b", "none")).toBe("none");
    expect(scalewayEffort("deepseek-v4-flash-0731", "none")).toBe("none");
  });

  it("leaves an unknown model's level alone, having nothing better to guess", () => {
    expect(scalewayEffort("some-future-model", "xhigh")).toBe("xhigh");
  });

  it("sends the level as Scaleway's own raw request field", () => {
    expect(scalewayReasoningConfig("qwen3.6-35b-a3b", "low")).toEqual({ modelKwargs: { reasoning_effort: "medium" } });
  });
});

describe("renameScalewayReasoning", () => {
  it("moves Scaleway's spelling to the one the SDK reads", () => {
    expect(renameScalewayReasoning({ role: "assistant", reasoning: "weighing it" })).toEqual({
      role: "assistant",
      reasoning: "weighing it",
      reasoning_content: "weighing it",
    });
  });

  it("leaves a payload without reasoning untouched", () => {
    const delta = { role: "assistant", content: "hi" };
    expect(renameScalewayReasoning(delta)).toBe(delta);
  });

  // If Scaleway ever adopts the standard field, the legacy one must not overwrite it.
  it("does not clobber an existing reasoning_content", () => {
    const delta = { reasoning: "old", reasoning_content: "new" };
    expect(renameScalewayReasoning(delta)).toBe(delta);
  });
});

/**
 * These drive a real ChatOpenAI so an SDK upgrade that renames or drops the protected conversion
 * hooks fails here rather than by silently dropping every Scaleway model's reasoning again.
 */
describe("createScalewayChatModel", () => {
  function sseResponse(events: object[]): Response {
    const body = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n";
    return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
  }

  function chunk(delta: object) {
    return {
      id: "cmpl-1",
      object: "chat.completion.chunk",
      created: 0,
      model: "qwen3.6-35b-a3b",
      choices: [{ index: 0, delta: { role: "assistant", ...delta }, finish_reason: null }],
    };
  }

  function model(respond: () => Response) {
    return createScalewayChatModel({
      model: "qwen3.6-35b-a3b",
      configuration: { baseURL: "https://api.scaleway.ai/v1", apiKey: "key-scaleway", fetch: async () => respond() },
    });
  }

  it("surfaces streamed reasoning that the SDK would otherwise discard", async () => {
    const chunks: AIMessageChunk[] = [];
    const stream = await model(() =>
      sseResponse([chunk({ reasoning: "weighing it" }), chunk({ content: "391" })]),
    ).stream([new HumanMessage("17*23?")]);
    for await (const c of stream) chunks.push(c);

    const reasoning = chunks.map((c) => c.additional_kwargs?.reasoning_content ?? "").join("");
    expect(reasoning).toBe("weighing it");
    expect(chunks.map((c) => c.content).join("")).toBe("391");
  });

  // modelGateway.invoke serves the non-streaming paths (compaction, summaries), which get the same
  // field name back from Scaleway and would drop it through the other conversion hook.
  it("surfaces reasoning on the non-streaming path too", async () => {
    const body = {
      id: "cmpl-1",
      object: "chat.completion",
      created: 0,
      model: "qwen3.6-35b-a3b",
      choices: [
        { index: 0, message: { role: "assistant", content: "391", reasoning: "17*23" }, finish_reason: "stop" },
      ],
      usage: { prompt_tokens: 17, completion_tokens: 16, total_tokens: 33 },
    };
    const message = await model(
      () => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } }),
    ).invoke([new HumanMessage("17*23?")]);

    expect(message.additional_kwargs?.reasoning_content).toBe("17*23");
    expect(message.content).toBe("391");
  });
});
