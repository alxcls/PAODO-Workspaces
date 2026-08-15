// The one doorway every model call passes through — agent turn, limit summary, compaction.
// Nothing else calls a provider, so cross-cutting concerns attach here instead of at three call sites.
import type { AIMessageChunk, BaseMessage } from "@langchain/core/messages";
import type { BindToolsInput } from "@langchain/core/language_models/chat_models";
import { createLogger } from "../infra/logger";
import { prepareMistralMessages } from "./mistralProtocol";
import { providerConcurrency, type ProviderConcurrencyGate } from "./providerConcurrency";

const log = createLogger("model");

/** Which call this is. The three have different shapes, so pacing and retry policy can differ. */
export type ModelCallStage = "model_turn" | "limit_synthesis" | "compaction";

export interface ModelUsage {
  inputTokensTotal: number;
  inputTokensCacheRead: number;
  inputTokensCacheWrite: number;
  outputTokensTotal: number;
  outputTokensReasoning: number;
}

export const NO_USAGE: ModelUsage = {
  inputTokensTotal: 0,
  inputTokensCacheRead: 0,
  inputTokensCacheWrite: 0,
  outputTokensTotal: 0,
  outputTokensReasoning: 0,
};

/**
 * Normalize one provider's token accounting. Providers agree on the totals and disagree on cache
 * attribution, so the normalized field is preferred and the two raw spellings are read after it.
 */
export function usageTokens(chunk: AIMessageChunk | null): ModelUsage {
  return {
    inputTokensTotal: chunk?.usage_metadata?.input_tokens ?? 0,
    outputTokensTotal: chunk?.usage_metadata?.output_tokens ?? 0,
    outputTokensReasoning: chunk?.usage_metadata?.output_token_details?.reasoning ?? 0,
    inputTokensCacheRead:
      chunk?.usage_metadata?.input_token_details?.cache_read ??
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (chunk?.response_metadata as any)?.usage?.prompt_cache_hit_tokens ??
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (chunk?.response_metadata as any)?.usage?.cached_tokens ??
      0,
    inputTokensCacheWrite: chunk?.usage_metadata?.input_token_details?.cache_creation ?? 0,
  };
}

/** What a caller must say about a call it is making. */
export interface ModelCall {
  stage: ModelCallStage;
  signal?: AbortSignal;
}

/**
 * A streaming call in progress. `accumulated` and `usage` are functions because they are only final
 * once `chunks` is drained — reading early reports what is known rather than faking a finished call.
 */
export interface ModelStream {
  chunks: AsyncGenerator<AIMessageChunk>;
  accumulated(): AIMessageChunk | null;
  usage(): ModelUsage;
  /** True once a chunk has reached the consumer. Past this point a retry would repeat visible text. */
  emitted(): boolean;
}

export interface ModelInvocation {
  message: AIMessageChunk;
  usage: ModelUsage;
}

/** One completed model call, as the observer sees it. */
export interface ModelCallRecord {
  provider: string;
  model: string;
  stage: ModelCallStage;
  usage: ModelUsage;
  durationMs: number;
  /** True when the consumer abandoned the stream before the provider finished (user abort). */
  partial: boolean;
  /** Whether any output reached the consumer — false means a failure here is still retryable unseen. */
  emitted: boolean;
  /** Calls this provider was carrying when this one started, this one included. */
  concurrent: number;
}

/**
 * Notified once per completed call — the seam for usage persistence, concurrency accounting, and the
 * pacing this gateway exists to enable. Must not throw; a throwing observer is a bug worth surfacing.
 */
export type ModelCallObserver = (record: ModelCallRecord) => void;

const logCall: ModelCallObserver = (record) => {
  log.debug({ event: "model_call_complete", ...record, ...record.usage }, "model call complete");
};

// The slice of LangChain this module uses, satisfied by both a chat model and the Runnable bindTools
// returns. That mismatch is why the call path used to be typed `any`.
interface StreamingChatModel {
  stream(messages: BaseMessage[], options?: { signal?: AbortSignal }): Promise<AsyncIterable<AIMessageChunk>>;
  invoke(messages: BaseMessage[], options?: { signal?: AbortSignal }): Promise<AIMessageChunk>;
}

interface BindableChatModel extends StreamingChatModel {
  bindTools?(tools: BindToolsInput[]): StreamingChatModel;
}

export interface ModelGateway {
  readonly provider: string;
  readonly model: string;
  stream(messages: BaseMessage[], call: ModelCall): Promise<ModelStream>;
  invoke(messages: BaseMessage[], call: ModelCall): Promise<ModelInvocation>;
  /** The same gateway with tools bound — shares this one's identity and observer. */
  bindTools(tools: BindToolsInput[]): ModelGateway;
}

export interface ModelGatewayOptions {
  provider: string;
  model: string;
  /** Defaults to a debug log line per call. */
  observe?: ModelCallObserver;
  /** Defaults to the process-wide counter. Inject a fresh one to keep tests from sharing state. */
  concurrency?: ProviderConcurrencyGate;
}

export function createModelGateway(chat: BindableChatModel, options: ModelGatewayOptions): ModelGateway {
  const { provider, model } = options;
  const observe = options.observe ?? logCall;
  const concurrency = options.concurrency ?? providerConcurrency;
  // Mistral's wire format is quarantined here. Other providers receive the caller's exact array;
  // Mistral receives a short-lived clone with its reasoning blocks and tool ids restored.
  const outboundMessages = (messages: BaseMessage[]) =>
    provider === "mistral" ? prepareMistralMessages(messages) : messages;

  // Every call is bracketed by this: enter before the request leaves, release exactly once when it
  // settles, and report what it cost. Both call shapes go through it so neither can skip accounting.
  const begin = (stage: ModelCallStage) => {
    const startedAt = Date.now();
    const release = concurrency.enter(provider);
    const concurrent = concurrency.snapshot(provider).active;
    return (usage: ModelUsage, partial: boolean, emitted: boolean) => {
      release();
      observe({ provider, model, stage, usage, durationMs: Date.now() - startedAt, partial, emitted, concurrent });
    };
  };

  return {
    provider,
    model,

    async stream(messages, call) {
      const finish = begin(call.stage);
      let accumulated: AIMessageChunk | null = null;
      let usage: ModelUsage = NO_USAGE;
      let settled = false;
      let drained = false;
      let emitted = false;

      let raw: AsyncIterable<AIMessageChunk>;
      try {
        raw = await chat.stream(outboundMessages(messages), { signal: call.signal });
      } catch (err) {
        settled = true;
        finish(NO_USAGE, true, false);
        throw err;
      }

      async function* chunks(): AsyncGenerator<AIMessageChunk> {
        try {
          for await (const chunk of raw) {
            accumulated = accumulated ? accumulated.concat(chunk) : chunk;
            emitted = true;
            yield chunk;
          }
          drained = true;
        } finally {
          // `finally`, not after the loop: a consumer that walks away mid-stream (the user pressing
          // escape) still has its spent tokens measured rather than losing them entirely.
          if (!settled) {
            settled = true;
            usage = usageTokens(accumulated);
            finish(usage, !drained, emitted);
          }
        }
      }

      return {
        chunks: chunks(),
        accumulated: () => accumulated,
        usage: () => usage,
        emitted: () => emitted,
      };
    },

    async invoke(messages, call) {
      const finish = begin(call.stage);
      let message: AIMessageChunk;
      try {
        message = await chat.invoke(outboundMessages(messages), { signal: call.signal });
      } catch (err) {
        finish(NO_USAGE, true, false);
        throw err;
      }
      const usage = usageTokens(message);
      finish(usage, false, true);
      return { message, usage };
    },

    bindTools(tools) {
      if (!chat.bindTools) throw new Error(`provider "${provider}" model "${model}" does not support tool binding`);
      return createModelGateway(chat.bindTools(tools), { provider, model, observe, concurrency });
    },
  };
}
