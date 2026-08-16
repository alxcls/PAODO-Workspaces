/**
 * What each vendor tells us about its own ceilings, normalized to one shape. Three spellings of the
 * same idea, confirmed by direct probe against live keys — see the table in each VENDORS entry.
 *
 * Read from the fetch override installed in buildModel.ts, because LangChain does not surface
 * response headers on a streaming call.
 */

/** One provider's rate-limit state at the instant a response came back. Fields absent when unreported. */
export interface RateLimitSnapshot {
  limitRequests?: number;
  remainingRequests?: number;
  limitTokens?: number;
  remainingTokens?: number;
  /** Epoch ms the window reopens, for the providers that say. Mistral does not. */
  resetAt?: number;
  /** What the call just made actually cost. Mistral only — the others make us estimate. */
  queryCost?: number;
}

interface VendorHeaders {
  limitRequests: string;
  remainingRequests: string;
  limitTokens: string;
  remainingTokens: string;
  /** Absent for vendors that report no reset (Mistral). */
  reset?: string;
  queryCost?: string;
  /** How `reset` is spelled: a duration from now, or an absolute instant. */
  resetFormat?: "duration" | "iso";
}

// Ordered by how distinctive the names are, so a probe cannot match two vendors. Anthropic leads
// because its prefix is unique; the two `x-ratelimit-*` dialects are distinguished by suffix.
const VENDORS: readonly VendorHeaders[] = [
  {
    limitRequests: "anthropic-ratelimit-requests-limit",
    remainingRequests: "anthropic-ratelimit-requests-remaining",
    limitTokens: "anthropic-ratelimit-tokens-limit",
    remainingTokens: "anthropic-ratelimit-tokens-remaining",
    reset: "anthropic-ratelimit-requests-reset",
    resetFormat: "iso",
  },
  {
    limitRequests: "x-ratelimit-limit-req-minute",
    remainingRequests: "x-ratelimit-remaining-req-minute",
    limitTokens: "x-ratelimit-limit-tokens-minute",
    remainingTokens: "x-ratelimit-remaining-tokens-minute",
    queryCost: "x-ratelimit-tokens-query-cost",
  },
  {
    limitRequests: "x-ratelimit-limit-requests",
    remainingRequests: "x-ratelimit-remaining-requests",
    limitTokens: "x-ratelimit-limit-tokens",
    remainingTokens: "x-ratelimit-remaining-tokens",
    reset: "x-ratelimit-reset-requests",
    resetFormat: "duration",
  },
];

/** A header that must be a non-negative count; anything else is treated as unreported. */
function count(headers: Headers, name: string): number | undefined {
  const raw = headers.get(name);
  if (raw === null) return undefined;
  const value = Number(raw.trim());
  return Number.isFinite(value) && value >= 0 ? value : undefined;
}

// OpenAI spells a reset as a duration from now — "12ms", "0s", "1m30s", "6m0s". Summed across every
// unit present, so an unseen combination still resolves. `ms` leads the alternation to beat `m`.
const DURATION_PART = /(\d+(?:\.\d+)?)(ms|s|m|h)/g;
const UNIT_MS: Record<string, number> = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000 };

export function parseResetDuration(raw: string): number | undefined {
  let total: number | undefined;
  for (const [, amount, unit] of raw.trim().matchAll(DURATION_PART)) {
    total = (total ?? 0) + Number(amount) * UNIT_MS[unit];
  }
  return total;
}

function resetAt(headers: Headers, vendor: VendorHeaders, now: number): number | undefined {
  if (!vendor.reset) return undefined;
  const raw = headers.get(vendor.reset);
  if (raw === null) return undefined;
  if (vendor.resetFormat === "iso") {
    const parsed = Date.parse(raw.trim());
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  const duration = parseResetDuration(raw);
  return duration === undefined ? undefined : now + duration;
}

// Standard HTTP, so it sits outside the vendor table: either a count of seconds or an HTTP date.
// It is often the only thing a 429 carries — measured, Mistral's 429s carry no rate-limit headers.
function retryAfter(headers: Headers, now: number): number | undefined {
  const raw = headers.get("retry-after");
  if (raw === null) return undefined;
  const text = raw.trim();
  const seconds = Number(text);
  if (Number.isFinite(seconds) && seconds >= 0) return now + seconds * 1_000;
  const date = Date.parse(text);
  return Number.isFinite(date) ? date : undefined;
}

/**
 * The rate-limit state a response reports, or null when it reports none.
 *
 * Null is the honest answer for DeepSeek and Moonshot, and for most 4xx — a refused request usually
 * carries no rate-limit headers, so a 429 teaches us little here beyond `retry-after`, and the rest
 * is handled by the pacer's own backstop.
 */
export function parseRateLimitHeaders(headers: Headers, now: number = Date.now()): RateLimitSnapshot | null {
  const retry = retryAfter(headers, now);
  for (const vendor of VENDORS) {
    const limitRequests = count(headers, vendor.limitRequests);
    const remainingRequests = count(headers, vendor.remainingRequests);
    const limitTokens = count(headers, vendor.limitTokens);
    const remainingTokens = count(headers, vendor.remainingTokens);
    // One recognized field is enough to claim the vendor: a partial set is still more than we knew.
    if (
      limitRequests === undefined &&
      remainingRequests === undefined &&
      limitTokens === undefined &&
      remainingTokens === undefined
    ) {
      continue;
    }
    // `retry-after` wins where both are present: it is the provider answering "when", while a reset
    // header describes the window in general.
    const reset = retry ?? resetAt(headers, vendor, now);
    const queryCost = vendor.queryCost ? count(headers, vendor.queryCost) : undefined;
    return {
      ...(limitRequests === undefined ? {} : { limitRequests }),
      ...(remainingRequests === undefined ? {} : { remainingRequests }),
      ...(limitTokens === undefined ? {} : { limitTokens }),
      ...(remainingTokens === undefined ? {} : { remainingTokens }),
      ...(reset === undefined ? {} : { resetAt: reset }),
      ...(queryCost === undefined ? {} : { queryCost }),
    };
  }
  return retry === undefined ? null : { resetAt: retry };
}
