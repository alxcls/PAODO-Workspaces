// The gateway is the only place the app talks to a provider: every call is measured, and announced
// to the observer exactly once. A pacing layer cannot budget traffic it never sees.
import { describe, it, expect } from "vitest";
import { AIMessage, AIMessageChunk, HumanMessage, ToolMessage, type BaseMessage } from "@langchain/core/messages";
import { mistralReplayContent } from "./mistralProtocol";
import { createModelGateway, usageTokens, NO_USAGE, type ModelCallRecord } from "./modelGateway";
import { withReplayMetadata } from "./reasoningReplay";
import { ProviderConcurrency } from "./providerConcurrency";
import { NOTICE_THRESHOLD_MS, ProviderPacer } from "./rateLimit/providerPacer";
import { MAX_ATTEMPTS, RateLimitExhaustedError } from "./rateLimit/retryPolicy";

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
  const seen: { messages: BaseMessage[]; signal?: AbortSignal }[] = [];
  return {
    seen,
    stream: async (messages: BaseMessage[], options?: { signal?: AbortSignal }) => {
      seen.push({ messages, ...(options?.signal ? { signal: options.signal } : {}) });
      return (async function* () {
        for (const c of chunks) yield c;
      })();
    },
    invoke: async (messages: BaseMessage[], options?: { signal?: AbortSignal }) => {
      seen.push({ messages, ...(options?.signal ? { signal: options.signal } : {}) });
      return chunks[chunks.length - 1];
    },
    bindTools: () => fakeChat(chunks),
  };
}

// A private counter per gateway: the real one is process-wide on purpose, which would otherwise let
// one test's calls show up in another's `concurrent`.
function recordingGateway(chunks: AIMessageChunk[], chatOverride?: unknown, provider = "mistral") {
  const records: ModelCallRecord[] = [];
  const chat = (chatOverride ?? fakeChat(chunks)) as ReturnType<typeof fakeChat>;
  const concurrency = new ProviderConcurrency();
  // Its own pacer and clock: the shared one would leak a drained bucket between tests, and real
  // backoff takes minutes. The fake sleep must advance that clock, or the admission loop spins.
  const slept: number[] = [];
  let clock = 1_700_000_000_000;
  const pacer = new ProviderPacer({
    now: () => clock,
    sleep: async (ms) => {
      await Promise.resolve();
      slept.push(ms);
      clock += ms;
    },
    random: () => 0.5,
  });
  const gateway = createModelGateway(chat as never, {
    provider,
    model: "mistral-large-4",
    observe: (record) => records.push(record),
    concurrency,
    pacer,
  });
  return { gateway, records, chat, concurrency, pacer, slept };
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
      model: "mistral-large-4",
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

  it("restores stored reasoning for Mistral without mutating the caller's history", async () => {
    const messages: BaseMessage[] = [
      new AIMessage({ content: "Act.", response_metadata: withReplayMetadata({}, "Plan first.") }),
    ];
    const { gateway, chat } = recordingGateway([chunk("done")]);

    await gateway.stream(messages, { stage: "model_turn" });

    expect(chat.seen[0].messages[0].content).toEqual(mistralReplayContent("Plan first.", "Act."));
    expect(messages[0].content).toBe("Act.");
  });

  it("leaves a turn another provider reasoned on exactly as stored", async () => {
    const messages: BaseMessage[] = [
      new AIMessage({ content: "Act.", response_metadata: withReplayMetadata({}, "Plan first.", "anthropic") }),
    ];
    const { gateway, chat } = recordingGateway([chunk("done")]);

    await gateway.stream(messages, { stage: "model_turn" });

    expect(chat.seen[0].messages[0]).toBe(messages[0]);
  });

  it("passes the exact original history to non-Mistral providers", async () => {
    const messages: BaseMessage[] = [
      new AIMessage({ content: "", tool_calls: [{ id: "call_openai_native", name: "file_read", args: {} }] }),
      new ToolMessage({ tool_call_id: "call_openai_native", content: "body" }),
    ];
    const { gateway, chat } = recordingGateway([chunk("done")], undefined, "deepseek");

    await gateway.stream(messages, { stage: "model_turn" });

    expect(chat.seen[0].messages).toBe(messages);
    expect((chat.seen[0].messages[0] as AIMessage).tool_calls![0].id).toBe("call_openai_native");
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

  it("uses the same Mistral boundary adapter as streaming calls", async () => {
    const messages: BaseMessage[] = [
      new AIMessage({ content: "Act.", response_metadata: withReplayMetadata({}, "Plan first.") }),
    ];
    const { gateway, chat } = recordingGateway([chunk("BRIEF")]);

    await gateway.invoke(messages, { stage: "compaction" });

    expect(chat.seen[0].messages[0].content).toEqual(mistralReplayContent("Plan first.", "Act."));
    expect(messages[0].content).toBe("Act.");
  });
});

describe("ModelGateway.bindTools", () => {
  // A bound gateway is the same account on the same provider, so it answers to the same policy. A
  // fresh observer would hide the app's most frequent call from any future budget.
  it("keeps identity and observer, so bound calls are measured alongside bare ones", async () => {
    const { gateway, records } = recordingGateway([chunk("x", { input: 5, output: 2 })]);
    const bound = gateway.bindTools([]);

    expect(bound.provider).toBe("mistral");
    expect(bound.model).toBe("mistral-large-4");

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
      model: "mistral-large-4",
    });
    expect(() => gateway.bindTools([])).toThrow(/mistral/);
  });

  it("shares the counter with the bound gateway, so bound and bare calls contend as one", async () => {
    const { gateway, concurrency } = recordingGateway([chunk("x", { input: 1, output: 1 })]);
    const call = await gateway.bindTools([]).stream(MESSAGES, { stage: "model_turn" });
    expect(concurrency.snapshot("mistral").active).toBe(1);
    for await (const _ of call.chunks) {
      // drain
    }
    expect(concurrency.snapshot("mistral").active).toBe(0);
  });
});

// Whether output has reached the user is what separates a failure that can be retried invisibly from
// one that cannot: past the first chunk, a second attempt would repeat text already on screen.
describe("ModelGateway — emitted output", () => {
  it("reports nothing emitted until the first chunk is consumed", async () => {
    const { gateway } = recordingGateway([chunk("a", { input: 1, output: 1 }), chunk("b")]);
    const call = await gateway.stream(MESSAGES, { stage: "model_turn" });

    expect(call.emitted()).toBe(false);
    await call.chunks.next();
    expect(call.emitted()).toBe(true);
  });

  it("marks a stream that produced no chunk at all as unemitted", async () => {
    const { gateway, records } = recordingGateway([]);
    const call = await gateway.stream(MESSAGES, { stage: "model_turn" });
    for await (const _ of call.chunks) {
      // drain
    }
    expect(records[0]).toMatchObject({ emitted: false, partial: false });
  });

  it("marks an abandoned stream as emitted, since its first chunks already reached the consumer", async () => {
    const { gateway, records } = recordingGateway([chunk("a", { input: 9, output: 1 }), chunk("b")]);
    const call = await gateway.stream(MESSAGES, { stage: "model_turn" });
    await call.chunks.next();
    await call.chunks.return(undefined);

    expect(records[0]).toMatchObject({ emitted: true, partial: true });
  });
});

describe("ModelGateway — concurrency accounting", () => {
  it("counts a call for as long as it is in flight, and releases it once drained", async () => {
    const { gateway, records, concurrency } = recordingGateway([chunk("x", { input: 3, output: 1 })]);
    const call = await gateway.stream(MESSAGES, { stage: "model_turn" });

    expect(concurrency.snapshot("mistral").active).toBe(1);
    for await (const _ of call.chunks) {
      // drain
    }
    expect(concurrency.snapshot("mistral")).toMatchObject({ active: 0, peak: 1, total: 1 });
    expect(records[0].concurrent).toBe(1);
  });

  it("sees overlapping calls as overlapping, which is the number a limit would be set against", async () => {
    const { gateway, records, concurrency } = recordingGateway([chunk("x", { input: 1, output: 1 })]);
    const first = await gateway.stream(MESSAGES, { stage: "model_turn" });
    const second = await gateway.stream(MESSAGES, { stage: "model_turn" });

    expect(concurrency.snapshot("mistral")).toMatchObject({ active: 2, peak: 2 });
    for await (const _ of first.chunks) {
      // drain
    }
    for await (const _ of second.chunks) {
      // drain
    }
    expect(concurrency.snapshot("mistral")).toMatchObject({ active: 0, peak: 2, total: 2 });
    expect(records.map((r) => r.concurrent)).toEqual([1, 2]);
  });

  // A leaked slot is permanent: the count never falls back and every later limit reads a provider
  // as busier than it is, throttling calls that should have gone straight out.
  it("releases the slot when the request fails before any stream exists", async () => {
    const failing = {
      stream: async () => {
        throw new Error("500 Internal Server Error");
      },
      invoke: async () => {
        throw new Error("500 Internal Server Error");
      },
    };
    const { gateway, records, concurrency } = recordingGateway([], failing);

    await expect(gateway.stream(MESSAGES, { stage: "model_turn" })).rejects.toThrow(/500/);
    await expect(gateway.invoke(MESSAGES, { stage: "compaction" })).rejects.toThrow(/500/);

    expect(concurrency.snapshot("mistral")).toMatchObject({ active: 0, total: 2 });
    expect(records).toHaveLength(2);
    expect(records.every((r) => r.emitted === false && r.usage === NO_USAGE)).toBe(true);
    // Nothing rate-limited happened, so nothing should have been retried or waited on.
    expect(records.every((r) => r.attempts === 1 && r.waitedMs === 0)).toBe(true);
  });
});

// The whole point of the pacing layer: a throttled provider must slow a run down, not end it. These
// assert the gateway's half — that a refusal nobody saw is retried, and one they saw is not.
describe("ModelGateway — rate limit retry", () => {
  const rateLimited = () => Object.assign(new Error("Requests rate limit exceeded"), { status: 429 });

  it("retries a 429 that arrived before any chunk, then succeeds", async () => {
    let attempts = 0;
    const notices: Array<{ attempt: number; waitMs: number }> = [];
    const flaky = {
      stream: async () => {
        attempts += 1;
        if (attempts < 3) throw rateLimited();
        return (async function* () {
          yield chunk("ok", { input: 5, output: 2 });
        })();
      },
      invoke: async () => chunk("ok"),
    };
    const { gateway, records, slept } = recordingGateway([], flaky);

    const call = await gateway.stream(MESSAGES, {
      stage: "model_turn",
      onPaced: ({ waitMs }) => notices.push({ attempt: attempts, waitMs }),
    });
    for await (const _ of call.chunks) {
      // drain
    }

    expect(attempts).toBe(3);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ attempts: 3, emitted: true });
    expect(records[0].waitedMs).toBeGreaterThan(0);
    // The first notice is emitted directly after the cold 429. No ceiling existed before that call,
    // so acquire() could not have announced an admission wait yet.
    expect(notices[0]).toMatchObject({ attempt: 1 });
    expect(notices[0].waitMs).toBeGreaterThanOrEqual(NOTICE_THRESHOLD_MS);
    // At least one wait per refusal; a learned ceiling can add pacing waits on top. The widening
    // of the backoff itself is asserted in the pacer's own tests.
    expect(slept.length).toBeGreaterThanOrEqual(2);
  });

  // Past the first chunk a retry would replay text the user has already read, so it must not happen.
  it("rethrows a failure that arrives after the consumer has seen output", async () => {
    let attempts = 0;
    const breaksMidStream = {
      stream: async () => {
        attempts += 1;
        return (async function* () {
          yield chunk("partial");
          throw rateLimited();
        })();
      },
      invoke: async () => chunk("ok"),
    };
    const { gateway, records } = recordingGateway([], breaksMidStream);

    const call = await gateway.stream(MESSAGES, { stage: "model_turn" });
    await expect(
      (async () => {
        for await (const _ of call.chunks) {
          // drain until it throws
        }
      })(),
    ).rejects.toThrow(/rate limit/);

    expect(attempts).toBe(1);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ attempts: 1, emitted: true, partial: true });
  });

  // A refusal that never clears is a cap, not throttling. Giving up beats waiting out the month,
  // and the call still has to appear in the ledger — it is the most expensive one of the run.
  it("gives up with a named error, and still reports the call", async () => {
    const alwaysRefuses = {
      stream: async () => {
        throw rateLimited();
      },
      invoke: async () => {
        throw rateLimited();
      },
    };
    const { gateway, records, concurrency } = recordingGateway([], alwaysRefuses);

    await expect(gateway.stream(MESSAGES, { stage: "model_turn" })).rejects.toThrow(RateLimitExhaustedError);

    expect(records).toHaveLength(1);
    expect(records[0].attempts).toBe(MAX_ATTEMPTS);
    expect(records[0].waitedMs).toBeGreaterThan(0);
    expect(concurrency.snapshot("mistral").active).toBe(0);
  });
});
