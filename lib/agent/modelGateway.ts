// The one doorway every model call passes through.
//
// Before this existed the app talked to providers from three places — the main agent turn and the
// iteration-limit summary (./modelTurn.ts), and history compaction (./compact.ts) — each holding a
// bare LangChain object typed `any`, each free to differ. Anything that has to be true of EVERY call
// (measure the tokens, pace the requests, classify the refusal) had to be written three times and
// remembered a fourth time by whoever added the next call site. Compaction is what that cost looks
// like in practice: it sends the largest inputs in the app and, until this seam, recorded none of them.
//
// So the rule is: NOTHING OUTSIDE THIS MODULE CALLS A PROVIDER. Callers get a ModelGateway and ask it
// to stream or invoke; the cross-cutting work happens here, in one order, for all of them.
//
// Token measurement is the first tenant. It is applied by construction rather than by convention —
// `usage()` is part of the handle a caller already has to hold, so a new call site cannot forget to
// account for itself the way compaction did.
import type { AIMessageChunk, BaseMessage } from "@langchain/core/messages";
import type { BindToolsInput } from "@langchain/core/language_models/chat_models";
import { createLogger } from "../infra/logger";

const log = createLogger("model");

/**
 * Which of the app's model calls this is.
 *
 * Carried on every call because the cross-cutting layers need to tell them apart: the three have very
 * different shapes (a tool-bound conversational turn, a one-shot closing summary, a very large
 * summarization), and a pacing or retry policy that treats them alike would be wrong for at least two.
 */
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
 * Normalize one provider's token accounting.
 *
 * Providers agree on the totals and disagree on cache attribution: LangChain surfaces it under
 * `usage_metadata.input_token_details` for those that report it there, while the OpenAI-compatible
 * vendors leave it in their raw response under two different names. All three are read, in the order
 * that prefers the normalized field.
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
 * A streaming call in progress.
 *
 * `chunks` is the provider's stream, unchanged. `accumulated` and `usage` are only final once that
 * generator is drained — which is why they are functions rather than fields: reading them early
 * returns what is known so far rather than pretending a half-consumed stream is complete.
 */
export interface ModelStream {
  chunks: AsyncGenerator<AIMessageChunk>;
  accumulated(): AIMessageChunk | null;
  usage(): ModelUsage;
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
}

/**
 * Notified once per completed call, whatever the outcome.
 *
 * The seam for everything that wants to watch traffic without being in its path — usage persistence,
 * concurrency accounting, and eventually the pacing this gateway exists to make possible. Observers
 * must not throw; the gateway does not guard the call, because a throwing observer is a bug that
 * should surface rather than silently drop a measurement.
 */
export type ModelCallObserver = (record: ModelCallRecord) => void;

const logCall: ModelCallObserver = (record) => {
  log.debug({ event: "model_call_complete", ...record, ...record.usage }, "model call complete");
};

/**
 * The slice of the LangChain surface this module actually uses.
 *
 * Named here so it can be satisfied by both a chat model and the Runnable that `bindTools` returns —
 * the mismatch between those two is the whole reason the call path used to be typed `any`.
 */
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
}

export function createModelGateway(chat: BindableChatModel, options: ModelGatewayOptions): ModelGateway {
  const { provider, model } = options;
  const observe = options.observe ?? logCall;

  const report = (stage: ModelCallStage, usage: ModelUsage, startedAt: number, partial: boolean) => {
    observe({ provider, model, stage, usage, durationMs: Date.now() - startedAt, partial });
  };

  return {
    provider,
    model,

    async stream(messages, call) {
      const startedAt = Date.now();
      const raw = await chat.stream(messages, { signal: call.signal });
      let accumulated: AIMessageChunk | null = null;
      let usage: ModelUsage = NO_USAGE;
      let settled = false;
      let drained = false;

      async function* chunks(): AsyncGenerator<AIMessageChunk> {
        try {
          for await (const chunk of raw) {
            accumulated = accumulated ? accumulated.concat(chunk) : chunk;
            yield chunk;
          }
          drained = true;
        } finally {
          // `finally` rather than after the loop: a consumer that walks away mid-stream — the user
          // pressing escape is the common one — still has its partial usage measured and reported.
          // Those tokens were spent and previously went unrecorded entirely.
          if (!settled) {
            settled = true;
            usage = usageTokens(accumulated);
            report(call.stage, usage, startedAt, !drained);
          }
        }
      }

      return { chunks: chunks(), accumulated: () => accumulated, usage: () => usage };
    },

    async invoke(messages, call) {
      const startedAt = Date.now();
      const message = await chat.invoke(messages, { signal: call.signal });
      const usage = usageTokens(message);
      report(call.stage, usage, startedAt, false);
      return { message, usage };
    },

    bindTools(tools) {
      if (!chat.bindTools) throw new Error(`provider "${provider}" model "${model}" does not support tool binding`);
      return createModelGateway(chat.bindTools(tools), { provider, model, observe });
    },
  };
}
