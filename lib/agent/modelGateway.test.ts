// The gateway is the only place the app talks to a provider: every call is measured, and announced
// to the observer exactly once. A pacing layer cannot budget traffic it never sees.
import { describe, it, expect } from "vitest";
import { AIMessageChunk, HumanMessage } from "@langchain/core/messages";
import { createModelGateway, usageTokens, NO_USAGE, type ModelCallRecord } from "./modelGateway";

function chunk(content: string, usage?: { input: number; output: number; reasoning?: number }): AIMessageChunk {
  return new AIMessageChunk({
    content,
    ...(usage
      ? {
          usage_metadata: {
            input_tokens: usage.input,
            output_tokens: usage.output,
            total_tokens: usage.input + usage.output,
            ...(usage.reasoning ? { output_token_details: { reasoning: usage.reasoning } } : {}),
          },
        }
      : {}),
  });
}

// A chat double standing in for whatever the registry built. Records what it was asked for so the
// gateway can be shown to pass the abort signal through rather than quietly dropping it.
function fakeChat(chunks: AIMessageChunk[]) {
  const seen: { signal?: AbortSignal }[] = [];
  return {
    seen,
    stream: async (_messages: never, options?: { signal?: AbortSignal }) => {
      seen.push({ ...(options?.signal ? { signal: options.signal } : {}) });
      return (async function* () {
        for (const c of chunks) yield c;
      })();
    },
    invoke: async (_messages: never, options?: { signal?: AbortSignal }) => {
      seen.push({ ...(options?.signal ? { signal: options.signal } : {}) });
      return chunks[chunks.length - 1];
    },
    bindTools: () => fakeChat(chunks),
  };
}

function recordingGateway(chunks: AIMessageChunk[]) {
  const records: ModelCallRecord[] = [];
  const chat = fakeChat(chunks);
  const gateway = createModelGateway(chat as never, {
    provider: "mistral",
    model: "mistral-small-2603",
    observe: (record) => records.push(record),
  });
  return { gateway, records, chat };
}

const MESSAGES = [new HumanMessage("hi")];

describe("usageTokens", () => {
  it("reads the normalized usage metadata", () => {
    expect(usageTokens(chunk("x", { input: 10, output: 4, reasoning: 3 }))).toMatchObject({
      inputTokensTotal: 10,
      outputTokensTotal: 4,
      outputTokensReasoning: 3,
    });
  });

  // The OpenAI-compatible vendors leave cache attribution in the raw response under names LangChain
  // does not normalize. Both spellings are read, so a cached prefix is not billed as fresh input.
  it("falls back to the raw provider cache fields when usage_metadata omits them", () => {
    const deepseek = new AIMessageChunk({ content: "", response_metadata: { usage: { prompt_cache_hit_tokens: 64 } } });
    const openaiish = new AIMessageChunk({ content: "", response_metadata: { usage: { cached_tokens: 128 } } });
    expect(usageTokens(deepseek).inputTokensCacheRead).toBe(64);
    expect(usageTokens(openaiish).inputTokensCacheRead).toBe(128);
  });

  it("reports zeros rather than guessing for a provider that sent no usage at all", () => {
    expect(usageTokens(null)).toEqual(NO_USAGE);
    expect(usageTokens(chunk("no usage block"))).toEqual(NO_USAGE);
  });
});

describe("ModelGateway.stream", () => {
  it("passes the provider's chunks through unchanged", async () => {
    const { gateway } = recordingGateway([chunk("Hel"), chunk("lo", { input: 9, output: 2 })]);
    const call = await gateway.stream(MESSAGES, { stage: "model_turn" });
    const seen: string[] = [];
    for await (const c of call.chunks) seen.push(String(c.content));
    expect(seen).toEqual(["Hel", "lo"]);
  });

  // Usage is a function, not a field, precisely so this is expressible: reading it early must report
  // what is actually known rather than imply a completed call.
  it("measures nothing until the stream is drained, then the whole call", async () => {
    const { gateway } = recordingGateway([chunk("a"), chunk("b", { input: 20, output: 5 })]);
    const call = await gateway.stream(MESSAGES, { stage: "model_turn" });
    expect(call.usage()).toEqual(NO_USAGE);
    for await (const _ of call.chunks) {
      // drain
    }
    expect(call.usage()).toMatchObject({ inputTokensTotal: 20, outputTokensTotal: 5 });
  });

  it("announces the completed call once, with the stage and provider it was made for", async () => {
    const { gateway, records } = recordingGateway([chunk("x", { input: 7, output: 1 })]);
    const call = await gateway.stream(MESSAGES, { stage: "limit_synthesis" });
    for await (const _ of call.chunks) {
      // drain
    }
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      provider: "mistral",
      model: "mistral-small-2603",
      stage: "limit_synthesis",
      partial: false,
      usage: { inputTokensTotal: 7, outputTokensTotal: 1 },
    });
  });

  // Escape abandons the generator mid-stream. Those tokens were spent and billed regardless, and
  // before the gateway they were recorded nowhere — the run just threw.
  it("still measures and reports a stream the consumer walks away from", async () => {
    const { gateway, records } = recordingGateway([
      chunk("one", { input: 12, output: 1 }),
      chunk("two"),
      chunk("three"),
    ]);
    const call = await gateway.stream(MESSAGES, { stage: "model_turn" });
    for await (const _ of call.chunks) break;

    expect(records).toHaveLength(1);
    expect(records[0].partial).toBe(true);
    expect(records[0].usage.inputTokensTotal).toBe(12);
  });

  it("forwards the abort signal to the provider", async () => {
    const { gateway, chat } = recordingGateway([chunk("x")]);
    const controller = new AbortController();
    await gateway.stream(MESSAGES, { stage: "model_turn", signal: controller.signal });
    expect(chat.seen[0].signal).toBe(controller.signal);
  });
});

describe("ModelGateway.invoke", () => {
  // Compaction is the only caller, and the call it makes is the largest the app sends. It went
  // entirely unmeasured until it came through here.
  it("measures and announces the call", async () => {
    const { gateway, records } = recordingGateway([chunk("BRIEF", { input: 40_000, output: 300 })]);
    const { message, usage } = await gateway.invoke(MESSAGES, { stage: "compaction" });

    expect(String(message.content)).toBe("BRIEF");
    expect(usage).toMatchObject({ inputTokensTotal: 40_000, outputTokensTotal: 300 });
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ stage: "compaction", partial: false });
  });
});

describe("ModelGateway.bindTools", () => {
  // A bound gateway is the same account on the same provider, so it answers to the same policy. A
  // fresh observer would hide the app's most frequent call from any future budget.
  it("keeps identity and observer, so bound calls are measured alongside bare ones", async () => {
    const { gateway, records } = recordingGateway([chunk("x", { input: 5, output: 2 })]);
    const bound = gateway.bindTools([]);

    expect(bound.provider).toBe("mistral");
    expect(bound.model).toBe("mistral-small-2603");

    const call = await bound.stream(MESSAGES, { stage: "model_turn" });
    for await (const _ of call.chunks) {
      // drain
    }
    expect(records).toHaveLength(1);
    expect(records[0].usage.inputTokensTotal).toBe(5);
  });

  it("names the provider when the underlying client cannot bind tools", () => {
    const gateway = createModelGateway({ stream: async () => [], invoke: async () => chunk("") } as never, {
      provider: "mistral",
      model: "mistral-small-2603",
    });
    expect(() => gateway.bindTools([])).toThrow(/mistral/);
  });
});
