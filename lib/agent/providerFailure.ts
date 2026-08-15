// Every way a run cannot reach a working model: the vocabulary, the rules that recognize each cause
// in the provider's own wording, and its message. Locally-known causes are in preflight, below.
import { throttleLog } from "../infra/logThrottle";

export const PROVIDER_CREDIT_EXHAUSTED_CODE = "PROVIDER_CREDIT_EXHAUSTED" as const;
export const PROVIDER_KEY_INVALID_CODE = "PROVIDER_KEY_INVALID" as const;
export const PROVIDER_KEY_MISSING_CODE = "PROVIDER_KEY_MISSING" as const;
export const PROVIDER_RATE_LIMITED_CODE = "PROVIDER_RATE_LIMITED" as const;
export const PROVIDER_UNAVAILABLE_CODE = "PROVIDER_UNAVAILABLE" as const;

/** Who refused, for message wording. Both parts are optional — not every call site knows both. */
export interface ProviderTarget {
  provider?: string;
  model?: string;
}

/** A provider failure, classified. The shape every rule produces and every consumer reads. */
export interface ProviderFailure {
  failureClass: string;
  failureCode: ClassifiedProviderCode;
  resource: string;
  resourceScope: string;
  /**
   * Whether waiting could help. False for a config or billing fact a retry cannot change; true for
   * throttling, which is the same refusal a funded account gets and clears on its own.
   */
  retryable: boolean;
  /** The HTTP status the provider answered with, when it gave one. */
  status?: number;
  /** The provider's own wording, bounded — the only part that says how it actually failed. */
  providerMessage: string;
}

interface ProviderFailureRule {
  code: string;
  failureClass: string;
  resource: string;
  resourceScope: string;
  retryable: boolean;
  /** Statuses decisive on their own. Any other needs the wording to agree, so an ordinary rate
   *  limit is never read as an empty account. */
  decisiveStatuses: readonly number[];
  /** One entry per observed provider wording. */
  patterns: readonly RegExp[];
  message: (failure: ProviderFailure, target: ProviderTarget) => string;
  /** Log event name, also the throttle bucket — one burst of an account-level failure logs once. */
  event: string;
  outcome: string;
  logMessage: string;
}

// Long enough for every wording below, short enough that a provider that returns an HTML error page
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

// Each SDK buries the meaning somewhere different — `code`, `error.message`, `type`. Search them
// all at once rather than guessing which one threw.
function searchableText(error: unknown): string {
  if (typeof error === "string") return error;
  const top = asObject(error);
  if (!top) return String(error);
  const nested = asObject(top.error);
  return [top.message, top.code, top.type, nested?.message, nested?.code, nested?.type]
    .filter((value): value is string => typeof value === "string")
    .join(" | ");
}

function providerMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : typeof error === "string" ? error : searchableText(error);
  // First line only: LangChain appends a multi-line troubleshooting URL to its wrapped errors.
  const line = raw.split("\n")[0].trim();
  return line.length > MAX_PROVIDER_MESSAGE ? `${line.slice(0, MAX_PROVIDER_MESSAGE - 1)}…` : line;
}

/**
 * ORDER IS PRECEDENCE — first match wins. Credit leads because a dry account answers 401 or a
 * balance-worded 429, and "replace your key" sends that operator to fix the wrong thing.
 */
const RULES = [
  {
    code: PROVIDER_CREDIT_EXHAUSTED_CODE,
    failureClass: "credit_exhaustion",
    resource: "llm_provider_credit_balance",
    resourceScope: "llm_provider_account",
    retryable: false,
    // 402 Payment Required is unambiguous on its own.
    decisiveStatuses: [402],
    patterns: [
      // DeepSeek 402 "Insufficient Balance"; OpenAI 429 code `insufficient_quota`.
      /insufficient[\s_-]*(balance|funds|credits?|quota)/i,
      // Anthropic 400 "Your credit balance is too low to access the Anthropic API".
      /credit balance is too low/i,
      // DeepSeek 429 — concurrency is scaled to the remaining balance, so this arrives BEFORE the
      // 402 and reads like ordinary throttling.
      /remaining balance|top ?up your balance/i,
      // OpenAI 429 "You exceeded your current quota, please check your plan and billing details".
      /exceeded your current quota/i,
      /billing[\s_-]*hard[\s_-]*limit/i,
      // Moonshot "Your account org-… is not active, please check your account balance".
      /check your account balance/i,
    ],
    message: (failure: ProviderFailure, target: ProviderTarget) => {
      const account = target.provider ? `The ${target.provider} account` : "The model provider account";
      const refused = target.model ? `${target.model} refused` : "the provider refused";
      const scope = target.provider ? ` on ${target.provider}` : "";
      return (
        `${account} has run out of credit, so ${refused} the request (${failure.providerMessage}). ` +
        `This run stopped here — no further model call${scope} can succeed until the account is topped up, ` +
        `or this workspace is switched to a provider that still has credit.`
      );
    },
    event: "provider_credit_exhausted",
    outcome: "run_stopped_no_credit",
    logMessage: "LLM provider account is out of credit",
  },
  {
    code: PROVIDER_KEY_INVALID_CODE,
    failureClass: "authentication",
    resource: "llm_provider_api_key",
    resourceScope: "deployment",
    retryable: false,
    // A disabled-account 401 is still a credential to replace, so it stays here; the credit rule
    // above has already claimed the wordings where an empty account is the real cause.
    decisiveStatuses: [401],
    patterns: [
      // OpenAI / DeepSeek / Mistral / Moonshot (all OpenAI-compatible): code `invalid_api_key`,
      // message "Incorrect API key provided" or "Authentication Fails".
      /invalid[\s_-]*api[\s_-]*key/i,
      /incorrect api key/i,
      /authentication[\s_-]*(fails|failed|error)/i,
      // Anthropic 401: type `authentication_error`, "invalid x-api-key".
      /invalid x-api-key/i,
      // Generic wording several SDKs wrap a 401 in before it reaches us.
      /unauthorized/i,
      /no auth credentials found/i,
    ],
    message: (failure: ProviderFailure, target: ProviderTarget) => {
      const named = target.provider ?? "the model provider";
      const where = target.provider ? `the ${target.provider} key` : "the key";
      return (
        `${named} rejected the API key this deployment is using (${failure.providerMessage}). ` +
        `This run stopped here — no retry can succeed until ${where} is replaced in Settings → Provider API keys. ` +
        `A key that used to work can also be revoked or expire upstream.`
      );
    },
    event: "provider_key_invalid",
    outcome: "run_stopped_bad_credential",
    logMessage: "LLM provider rejected the configured API key",
  },
  {
    code: PROVIDER_RATE_LIMITED_CODE,
    failureClass: "rate_limit",
    resource: "llm_provider_request_quota",
    resourceScope: "llm_provider_account",
    // The only retryable rule: the account is fine and the key is fine, we simply asked too fast.
    retryable: true,
    // Last on purpose — a balance-worded 429 belongs to the credit rule, which has already run.
    // 529 is Anthropic's overload: a different cause, but the same "wait and ask again" remedy.
    decisiveStatuses: [429, 529],
    patterns: [
      /rate[\s_-]*limit/i,
      /too many requests/i,
      // Mistral "Requests rate limit exceeded"; OpenAI "Limit: 30000 tokens per min (TPM)".
      /requests? per (second|minute|day)|tokens? per (minute|day)/i,
      // OpenAI when the shared pool, not the account, is out of room.
      /service tier capacity exceeded/i,
      // Anthropic 529 `overloaded_error`.
      /overloaded/i,
    ],
    message: (failure: ProviderFailure, target: ProviderTarget) => {
      const named = target.provider ?? "The model provider";
      const scope = target.model ? ` for ${target.model}` : "";
      return (
        `${named} is refusing requests${scope} because they arrived too quickly (${failure.providerMessage}). ` +
        `Nothing is wrong with the account or the key — the same request should succeed once the ` +
        `provider's window resets.`
      );
    },
    event: "provider_rate_limited",
    outcome: "run_stopped_rate_limited",
    logMessage: "LLM provider is throttling this deployment",
  },
] as const satisfies readonly ProviderFailureRule[];

type Rule = (typeof RULES)[number];

/** A cause the provider itself reports — one of the RULES above. */
export type ClassifiedProviderCode = Rule["code"];

/** A cause known locally, before any request. */
export type LocalProviderCode = typeof PROVIDER_UNAVAILABLE_CODE | typeof PROVIDER_KEY_MISSING_CODE;

export type ProviderFailureCode = ClassifiedProviderCode | LocalProviderCode;

/** Empty today. Named so that adding one retryable rule updates every consumer's types at once. */
type RetryableProviderCode = Extract<Rule, { retryable: true }>["code"];

/**
 * Every provider failure no retry can fix. Derived from the rules' own `retryable` rather than
 * hand-listed, so a rule added above cannot be one this silently omits.
 */
export type TerminalProviderCode = LocalProviderCode | Exclude<ClassifiedProviderCode, RetryableProviderCode>;

/** The rules' public facts, so a consumer can reason about a cause it has never seen an instance
 *  of — which is what TERMINAL_PROVIDER_CODES does. */
export const CLASSIFIED_PROVIDER_FAILURES: readonly { code: ClassifiedProviderCode; retryable: boolean }[] = RULES.map(
  ({ code, retryable }) => ({ code, retryable }),
);

export const TERMINAL_PROVIDER_CODES: readonly TerminalProviderCode[] = [
  PROVIDER_UNAVAILABLE_CODE,
  PROVIDER_KEY_MISSING_CODE,
  // The cast carries what the filter proves and the type system cannot: exactly the rules whose
  // `retryable` is false, which is how TerminalProviderCode is defined.
  ...CLASSIFIED_PROVIDER_FAILURES.filter(({ retryable }) => !retryable).map(
    ({ code }) => code as Exclude<ClassifiedProviderCode, RetryableProviderCode>,
  ),
];

export function isTerminalProviderCode(code: string | undefined): code is TerminalProviderCode {
  return TERMINAL_PROVIDER_CODES.some((terminal) => terminal === code);
}

function ruleFor(code: ClassifiedProviderCode): Rule {
  const rule = RULES.find((candidate) => candidate.code === code);
  // Unreachable: every ClassifiedProviderCode is by definition one of RULES' codes.
  if (!rule) throw new Error(`no provider failure rule for "${code}"`);
  return rule;
}

/**
 * Classify a provider's refusal. Null for anything unrecognized — the caller shows the raw error,
 * because inventing a cause is worse than quoting the provider.
 */
export function classifyProviderFailure(error: unknown): ProviderFailure | null {
  const status = providerStatus(error);
  const text = searchableText(error);
  for (const rule of RULES) {
    // Widened because `as const` gives each rule its own literal tuple type, and `includes` across
    // that union would otherwise only accept a status every rule agrees on — of which there are none.
    const decisive = status !== undefined && (rule.decisiveStatuses as readonly number[]).includes(status);
    if (!decisive && !rule.patterns.some((pattern) => pattern.test(text))) continue;
    return {
      failureClass: rule.failureClass,
      failureCode: rule.code,
      resource: rule.resource,
      resourceScope: rule.resourceScope,
      retryable: rule.retryable,
      ...(status === undefined ? {} : { status }),
      providerMessage: providerMessage(error),
    };
  }
  return null;
}

/** The explanation shown in the conversation where the run stopped. */
export function providerFailureMessage(failure: ProviderFailure, target: ProviderTarget = {}): string {
  return ruleFor(failure.failureCode).message(failure, target);
}

/**
 * One queryable record per account-level failure, throttled: a dry balance fails every workspace on
 * that provider within seconds (18 runs in 8s, once), and the burst would rotate the log.
 */
export function reportProviderFailure(
  logger: ErrorLogger,
  error: unknown,
  context: { workspaceId: string; provider?: string; model?: string; stage: string },
  now = Date.now(),
): ProviderFailure | null {
  const failure = classifyProviderFailure(error);
  if (!failure) return null;
  const rule = ruleFor(failure.failureCode);

  const suppressed = throttleLog(`${rule.event}:${context.provider ?? "unknown"}`, now);
  if (suppressed !== null) {
    logger.error(
      { event: rule.event, outcome: rule.outcome, err: error, ...context, ...failure, suppressed },
      rule.logMessage,
    );
  }
  return failure;
}

/**
 * Whether a run can be attempted at all, before the first request. Null means proceed. A switched-off
 * provider outranks its purged key: the consequence would send the operator to a form lacking it.
 */
export function preflightProviderFailure(
  config: { provider: string; model: string; apiKey?: string },
  offeredProviders: readonly string[],
): { code: LocalProviderCode; message: string } | null {
  if (!config.provider) {
    return {
      code: PROVIDER_UNAVAILABLE_CODE,
      message:
        "This deployment offers no LLM providers — every supported provider is switched off in its " +
        "configuration. No workspace can run until at least one is switched back on.",
    };
  }
  if (!offeredProviders.includes(config.provider)) {
    return {
      code: PROVIDER_UNAVAILABLE_CODE,
      message:
        `This workspace is set to ${config.provider}, which this deployment has switched off ` +
        `(${config.provider.toUpperCase()}_AVAILABLE=false). Its stored API key was deleted when it was ` +
        `withdrawn. Pick another provider for this workspace, or switch ${config.provider} back on.`,
    };
  }
  if (!config.apiKey) {
    return {
      code: PROVIDER_KEY_MISSING_CODE,
      message:
        `No API key set for ${config.provider}. This run stopped before contacting it — add the key ` +
        `in Settings → Provider API keys, then send the message again.`,
    };
  }
  return null;
}
