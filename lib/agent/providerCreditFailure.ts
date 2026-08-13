// Recognizes the one model-provider failure that no retry, no longer run and no different model on
// the same key can fix: the account behind the API key has no money left.
//
// Every provider words it differently, and DeepSeek words it twice — it first shrinks the allowed
// concurrency to match the remaining balance (a 429 that reads like ordinary throttling), then
// refuses outright with a 402. Both mean the same thing, so the wording is matched here once and
// turned into a stable code the agent loop can surface as the reason a run stopped, instead of
// leaking `String(err)` — or, when the failure lands in a best-effort catch, nothing at all.

import { throttleLog } from "../infra/logThrottle";

export const PROVIDER_CREDIT_EXHAUSTED_CODE = "PROVIDER_CREDIT_EXHAUSTED" as const;

export type ProviderCreditExhaustion = {
  failureClass: "credit_exhaustion";
  failureCode: typeof PROVIDER_CREDIT_EXHAUSTED_CODE;
  resource: "llm_provider_credit_balance";
  resourceScope: "llm_provider_account";
  retryable: false;
  /** The HTTP status the provider answered with: 402, or a 429 whose limit is derived from balance. */
  status?: number;
  /** The provider's own wording, bounded — the only part that says how the account actually failed. */
  providerMessage: string;
};

// One entry per observed provider wording. Matched against message *and* machine code, because
// which of the two carries the meaning differs per SDK.
const CREDIT_EXHAUSTED_PATTERNS = [
  // DeepSeek 402 "Insufficient Balance"; OpenAI 429 code `insufficient_quota`.
  /insufficient[\s_-]*(balance|funds|credits?|quota)/i,
  // Anthropic 400 "Your credit balance is too low to access the Anthropic API".
  /credit balance is too low/i,
  // DeepSeek 429 — concurrency is scaled to what is left, so this arrives *before* the 402:
  // "Your current concurrency is N, which exceeds your concurrency limit of N based on your
  // remaining balance. Please top up your balance to restore your concurrency."
  /remaining balance|top ?up your balance/i,
  // OpenAI 429 "You exceeded your current quota, please check your plan and billing details".
  /exceeded your current quota/i,
  /billing[\s_-]*hard[\s_-]*limit/i,
  // Moonshot "Your account org-… is not active, please check your account balance".
  /check your account balance/i,
];

// Long enough for every wording above, short enough that a provider that returns an HTML error page
// cannot push the rest of the log line out of view.
const MAX_PROVIDER_MESSAGE = 200;

type ErrorLike = Record<string, unknown>;

type ErrorLogger = {
  error(bindings: Record<string, unknown>, message: string): void;
};

function asObject(value: unknown): ErrorLike | undefined {
  return value && typeof value === "object" ? (value as ErrorLike) : undefined;
}

function providerStatus(error: unknown): number | undefined {
  const top = asObject(error);
  const nested = asObject(top?.error);
  if (typeof top?.status === "number") return top.status;
  if (typeof nested?.status === "number") return nested.status;
  return undefined;
}

// Providers bury the useful half in different places: the OpenAI-compatible SDKs put a machine code
// on `code` and the prose on `error.message`, Anthropic puts both on the top-level message. Search
// all of them at once rather than guessing which SDK threw.
function searchableText(error: unknown): string {
  if (typeof error === "string") return error;
  const top = asObject(error);
  if (!top) return String(error);
  const nested = asObject(top.error);
  return [top.message, top.code, nested?.message, nested?.code]
    .filter((value): value is string => typeof value === "string")
    .join(" | ");
}

function providerMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : typeof error === "string" ? error : searchableText(error);
  // First line only: LangChain appends a multi-line troubleshooting URL to its wrapped errors.
  const line = raw.split("\n")[0].trim();
  return line.length > MAX_PROVIDER_MESSAGE ? `${line.slice(0, MAX_PROVIDER_MESSAGE - 1)}…` : line;
}

/** Turn a provider's out-of-credit wording into fields the run can surface and operators can alert on. */
export function classifyProviderCreditExhaustion(error: unknown): ProviderCreditExhaustion | null {
  const status = providerStatus(error);
  const text = searchableText(error);
  // 402 Payment Required is unambiguous on its own; every other status needs the wording to agree,
  // so an ordinary 429 rate limit is never mistaken for an empty account.
  const isCreditFailure = status === 402 || CREDIT_EXHAUSTED_PATTERNS.some((p) => p.test(text));
  if (!isCreditFailure) return null;
  return {
    failureClass: "credit_exhaustion",
    failureCode: PROVIDER_CREDIT_EXHAUSTED_CODE,
    resource: "llm_provider_credit_balance",
    resourceScope: "llm_provider_account",
    retryable: false,
    ...(status === undefined ? {} : { status }),
    providerMessage: providerMessage(error),
  };
}

/** The explanation shown in the conversation where the run stopped. */
export function providerCreditExhaustedMessage(
  failure: ProviderCreditExhaustion,
  target: { provider?: string; model?: string } = {},
): string {
  const account = target.provider ? `The ${target.provider} account` : "The model provider account";
  const refused = target.model ? `${target.model} refused` : "the provider refused";
  const scope = target.provider ? ` on ${target.provider}` : "";
  return (
    `${account} has run out of credit, so ${refused} the request (${failure.providerMessage}). ` +
    `This run stopped here — no further model call${scope} can succeed until the account is topped up, ` +
    `or this workspace is switched to a provider that still has credit.`
  );
}

/**
 * Emit one queryable record for an out-of-credit provider, and return the classification.
 *
 * A dry account fails every workspace pointed at it within seconds — 18 runs in 8 seconds, in the
 * incident this was built for. Collapse the identical account-level failure into one line per
 * window so the burst cannot rotate the surrounding evidence out of the log. Per-run attribution is
 * not lost: each run still records its own error (code + message) against its workspace.
 */
export function reportProviderCreditExhaustion(
  logger: ErrorLogger,
  error: unknown,
  context: { workspaceId: string; provider?: string; model?: string; stage: string },
  now = Date.now(),
): ProviderCreditExhaustion | null {
  const failure = classifyProviderCreditExhaustion(error);
  if (!failure) return null;

  const suppressed = throttleLog(`provider_credit_exhausted:${context.provider ?? "unknown"}`, now);
  if (suppressed !== null) {
    logger.error(
      {
        event: "provider_credit_exhausted",
        outcome: "run_stopped_no_credit",
        err: error,
        ...context,
        ...failure,
        suppressed,
      },
      "LLM provider account is out of credit",
    );
  }
  return failure;
}
