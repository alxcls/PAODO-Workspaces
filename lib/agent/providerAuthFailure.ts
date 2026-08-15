// Recognizes the provider failure that BYOK makes routine: the key is present but the provider will
// not accept it. Sibling of ./providerCreditFailure.ts, same shape, different cause — that one is an
// account with no money, this one is a credential the account does not recognize.
//
// This did not need to exist while keys came from .env, because a key that never worked would have
// failed on the deploy that introduced it, in front of whoever wrote it. Now an operator pastes a key
// into a form, and the ordinary mistakes — a copied truncation, a trailing newline, a key from the
// wrong vendor pasted into the wrong row, a key revoked upstream months later — all arrive here.
// Left unclassified they surface as raw `String(err)` in the transcript, which tells the one person
// who could fix it nothing about what to fix.
//
// KEPT SEPARATE from "no key set at all". That case is known locally, before any request, and is
// answered by PROVIDER_KEY_MISSING in ./providerFailure.ts. Only a key we actually sent and the
// provider actually rejected lands here.
import { throttleLog } from "../infra/logThrottle";

export const PROVIDER_KEY_INVALID_CODE = "PROVIDER_KEY_INVALID" as const;

export type ProviderAuthFailure = {
  failureClass: "authentication";
  failureCode: typeof PROVIDER_KEY_INVALID_CODE;
  resource: "llm_provider_api_key";
  resourceScope: "deployment";
  retryable: false;
  /** The HTTP status the provider answered with — 401 for every vendor observed so far. */
  status?: number;
  /** The provider's own wording, bounded. */
  providerMessage: string;
};

// One entry per observed provider wording. Matched against message *and* machine code, because which
// of the two carries the meaning differs per SDK.
const AUTH_FAILURE_PATTERNS = [
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
];

// A 401 whose body says the account is disabled rather than the key is wrong is still a credential
// the operator has to replace, so it is not excluded — but an out-of-credit 402/429 must never land
// here, because "replace your key" is the wrong instruction for an empty account. Credit exhaustion
// is classified first at both call sites; these patterns are also written not to match its wording.
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

/** Turn a provider's rejected-credential wording into fields the run can surface. */
export function classifyProviderAuthFailure(error: unknown): ProviderAuthFailure | null {
  const status = providerStatus(error);
  const text = searchableText(error);
  // 401 is unambiguous on its own. Any other status needs the wording to agree, so a 400 that merely
  // mentions a key — "model does not support ..." style errors often quote the request — is not
  // mistaken for a bad credential.
  const isAuthFailure = status === 401 || AUTH_FAILURE_PATTERNS.some((p) => p.test(text));
  if (!isAuthFailure) return null;
  return {
    failureClass: "authentication",
    failureCode: PROVIDER_KEY_INVALID_CODE,
    resource: "llm_provider_api_key",
    resourceScope: "deployment",
    retryable: false,
    ...(status === undefined ? {} : { status }),
    providerMessage: providerMessage(error),
  };
}

/** The explanation shown in the conversation where the run stopped. */
export function providerKeyInvalidMessage(failure: ProviderAuthFailure, target: { provider?: string } = {}): string {
  const named = target.provider ?? "the model provider";
  const where = target.provider ? `the ${target.provider} key` : "the key";
  return (
    `${named} rejected the API key this deployment is using (${failure.providerMessage}). ` +
    `This run stopped here — no retry can succeed until ${where} is replaced in Settings → Provider API keys. ` +
    `A key that used to work can also be revoked or expire upstream.`
  );
}

/**
 * Emit one queryable record for a rejected key, and return the classification.
 *
 * Throttled per provider for the same reason credit exhaustion is: one bad key fails every workspace
 * pointed at that provider within seconds, and the burst would rotate the surrounding evidence out of
 * the log. Per-run attribution is not lost — each run still records its own error against its
 * workspace.
 */
export function reportProviderAuthFailure(
  logger: ErrorLogger,
  error: unknown,
  context: { workspaceId: string; provider?: string; model?: string; stage: string },
  now = Date.now(),
): ProviderAuthFailure | null {
  const failure = classifyProviderAuthFailure(error);
  if (!failure) return null;

  const suppressed = throttleLog(`provider_key_invalid:${context.provider ?? "unknown"}`, now);
  if (suppressed !== null) {
    logger.error(
      {
        event: "provider_key_invalid",
        outcome: "run_stopped_bad_credential",
        err: error,
        ...context,
        ...failure,
        suppressed,
      },
      "LLM provider rejected the configured API key",
    );
  }
  return failure;
}
