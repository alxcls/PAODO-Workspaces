// The one doorway every model call passes through — agent turn, limit summary, compaction.
// Nothing else calls a provider, so cross-cutting concerns attach here instead of at three call sites.
import type { AIMessageChunk, BaseMessage } from "@langchain/core/messages";
import type { BindToolsInput } from "@langchain/core/language_models/chat_models";
import { createLogger } from "../infra/logger";
import { prepareDeepSeekMessages } from "./deepseekProtocol";
import { prepareMistralMessages } from "./mistralProtocol";
import { providerConcurrency, type ProviderConcurrencyGate } from "./providerConcurrency";
import { NOTICE_THRESHOLD_MS, providerPacer, type PacerKey, type ProviderPacer } from "./rateLimit/providerPacer";
import { RateLimitExhaustedError, RetryBudget } from "./rateLimit/retryPolicy";
import { classifyProviderFailure, PROVIDER_RATE_LIMITED_CODE } from "./providerFailure";

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

/** A wait the pacer imposed, surfaced so the UI can say why a run has gone quiet. */
export interface PacedNotice {
  provider: string;
  model: string;
  waitMs: number;
  queueDepth: number;
}

/** What a caller must say about a call it is making. */
export interface ModelCall {
  stage: ModelCallStage;
  signal?: AbortSignal;
  /**
   * Told when this call is about to wait on a rate limit, before it sleeps. The call is suspended at
   * this point and cannot yield, so the caller is handed the news instead of discovering it later.
   */
  onPaced?: (notice: PacedNotice) => void;
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
  /** Tries this call took, first included. Above 1 means the provider refused and we waited. */
  attempts: number;
  /** Time spent blocked by the pacer or by backoff, across every attempt. */
  waitedMs: number;
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
  /** Defaults to the process-wide pacer. Inject a fresh one to keep tests from sharing state. */
  pacer?: ProviderPacer;
}

/**
 * Rewrites the outbound message array for one provider, leaving the caller's originals untouched.
 *
 * `chat` is how a provider whose injection happens INSIDE the client reaches it — DeepSeek's
 * reasoning_content is dropped by LangChain's converter, so its adapter hands the reasoning to the
 * client instead of writing it onto a message. Adapters that only reshape messages ignore it.
 */
type OutboundAdapter = (messages: BaseMessage[], chat: BindableChatModel) => BaseMessage[];

// One entry per provider that cannot accept canonical history verbatim. Adding a provider here is the
// whole wiring: nothing in the runner or the turn reader learns a vendor's name.
const OUTBOUND_ADAPTERS: Record<string, OutboundAdapter> = {
  mistral: prepareMistralMessages,
  deepseek: prepareDeepSeekMessages,
};

/** One paced attempt that succeeded, plus the bookkeeping its caller still owes. */
interface Attempt<T> {
  value: T;
  /** Releases the bucket reservation and the in-flight count, then reports the call. Call once. */
  finish(usage: ModelUsage, partial: boolean, emitted: boolean): void;
}

export function createModelGateway(chat: BindableChatModel, options: ModelGatewayOptions): ModelGateway {
  const { provider, model } = options;
  const observe = options.observe ?? logCall;
  const concurrency = options.concurrency ?? providerConcurrency;
  const pacer = options.pacer ?? providerPacer;
  const pacerKey: PacerKey = { provider, model };
  // Vendor wire formats are quarantined behind OUTBOUND_ADAPTERS. A provider without one receives the
  // caller's exact array; the rest get a short-lived clone carrying whatever they refuse to go without.
  const adapt = OUTBOUND_ADAPTERS[provider];
  const outboundMessages = (messages: BaseMessage[]) => (adapt ? adapt(messages, chat) : messages);

  /**
   * Run one logical call: wait for the provider's quota, try it, and on a refusal that reached no
   * consumer, wait longer and try again.
   *
   * Retrying is safe only because nothing has been emitted yet. LangChain's `Runnable.stream` pulls
   * the first chunk inside its own setup, so a 429 rejects here rather than mid-iteration; a failure
   * after the first chunk surfaces to the consumer instead and is never retried.
   *
   * One record per logical call, not per attempt — `attempts` and `waitedMs` carry what the retries
   * cost, so the observer contract stays one-in one-out.
   */
  const perform = async <T>(call: ModelCall, run: () => Promise<T>): Promise<Attempt<T>> => {
    const startedAt = Date.now();
    const budget = new RetryBudget();
    for (;;) {
      const lease = await pacer.acquire(pacerKey, {
        ...(call.signal ? { signal: call.signal } : {}),
        onPaced: ({ waitMs, queueDepth }) => call.onPaced?.({ provider, model, waitMs, queueDepth }),
      });
      budget.recordWait(lease.waitedMs);
      budget.startAttempt();
      const release = concurrency.enter(provider);
      const concurrent = concurrency.snapshot(provider).active;
      try {
        const value = await run();
        // Only a call that had to wait says anything about the ceiling being tight; one that walked
        // straight through is no evidence the learned recovery is too long.
        if (lease.waitedMs > 0) pacer.reward(pacerKey);
        return {
          value,
          finish: (usage, partial, emitted) => {
            release();
            lease.release();
            observe({
              provider,
              model,
              stage: call.stage,
              usage,
              durationMs: Date.now() - startedAt,
              partial,
              emitted,
              concurrent,
              attempts: budget.attemptsMade,
              waitedMs: budget.waitedMs,
            });
          },
        };
      } catch (err) {
        // Freed before the backoff, not after: a sleeping retry is not a call in flight, and holding
        // the reservation would make the bucket look fuller than it is for the whole wait.
        release();
        lease.release();
        // A call that gave up after eight attempts and ten minutes is the one most worth having in
        // the ledger, so both terminal paths report before they throw.
        const abandon = (thrown: unknown) => {
          observe({
            provider,
            model,
            stage: call.stage,
            usage: NO_USAGE,
            durationMs: Date.now() - startedAt,
            partial: true,
            emitted: false,
            concurrent,
            attempts: budget.attemptsMade,
            waitedMs: budget.waitedMs,
          });
          return thrown;
        };
        if (classifyProviderFailure(err)?.failureCode !== PROVIDER_RATE_LIMITED_CODE) throw abandon(err);
        // Budget is checked before the sleep, so a call with nothing left gives up now rather than
        // after one more pointless wait.
        const backoff = pacer.penalize(pacerKey);
        if (!budget.canRetry(backoff)) {
          throw abandon(new RateLimitExhaustedError(provider, model, budget.attemptsMade, budget.waitedMs, err));
        }
        // This wait happens after admission, so acquire() cannot announce it. Surface it explicitly;
        // otherwise the first cold 429 leaves the conversation looking frozen until the retry.
        if (backoff >= NOTICE_THRESHOLD_MS) {
          call.onPaced?.({ provider, model, waitMs: backoff, queueDepth: 0 });
        }
        budget.recordWait(backoff);
        await pacer.wait(backoff, call.signal);
      }
    }
  };

  return {
    provider,
    model,

    async stream(messages, call) {
      let accumulated: AIMessageChunk | null = null;
      let usage: ModelUsage = NO_USAGE;
      let settled = false;
      let drained = false;
      let emitted = false;

      // Throws only once retrying is pointless — nothing to release here, `perform` owns that.
      const attempt = await perform(call, () => chat.stream(outboundMessages(messages), { signal: call.signal }));
      const raw = attempt.value;
      const finish = attempt.finish;

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
            pacer.observeUsage(pacerKey, usage.inputTokensTotal + usage.outputTokensTotal);
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
      const attempt = await perform(call, () => chat.invoke(outboundMessages(messages), { signal: call.signal }));
      const message = attempt.value;
      const usage = usageTokens(message);
      // Where the provider prices the call itself the header already taught the pacer more; this is
      // the fallback that keeps the estimate honest for the ones that do not.
      pacer.observeUsage(pacerKey, usage.inputTokensTotal + usage.outputTokensTotal);
      attempt.finish(usage, false, true);
      return { message, usage };
    },

    bindTools(tools) {
      if (!chat.bindTools) throw new Error(`provider "${provider}" model "${model}" does not support tool binding`);
      return createModelGateway(chat.bindTools(tools), { provider, model, observe, concurrency, pacer });
    },
  };
}
