// Fixtures are verbatim from live probes against this deployment's own keys — a parser written to
// guessed header names would pass its tests and read nothing in production.
import { describe, it, expect } from "vitest";
import { parseRateLimitHeaders, parseResetDuration } from "./rateLimitHeaders";

const NOW = 1_700_000_000_000;

const MISTRAL = new Headers({
  "x-ratelimit-limit-tokens-minute": "250000",
  "x-ratelimit-remaining-tokens-minute": "243582",
  "x-ratelimit-tokens-query-cost": "6416",
  "x-ratelimit-limit-req-minute": "4",
  "x-ratelimit-remaining-req-minute": "3",
});

const OPENAI = new Headers({
  "x-ratelimit-limit-requests": "5000",
  "x-ratelimit-limit-tokens": "2000000",
  "x-ratelimit-remaining-requests": "4999",
  "x-ratelimit-remaining-tokens": "1999997",
  "x-ratelimit-reset-requests": "12ms",
  "x-ratelimit-reset-tokens": "0s",
});

// Captured from a live Scaleway qwen3.6 response. The two reset clocks are independent and must not
// be collapsed: the request bucket refills one request much more slowly than the token bucket here.
const SCALEWAY = new Headers({
  "x-ratelimit-limit-requests": "300",
  "x-ratelimit-reset-requests": "200ms",
  "x-ratelimit-remaining-requests": "149",
  "x-ratelimit-limit-tokens": "200000",
  "x-ratelimit-reset-tokens": "3ms",
  "x-ratelimit-remaining-tokens": "99987",
});

const ANTHROPIC = new Headers({
  "anthropic-ratelimit-requests-limit": "10000",
  "anthropic-ratelimit-requests-remaining": "9999",
  "anthropic-ratelimit-requests-reset": "2026-08-16T10:28:31Z",
  "anthropic-ratelimit-tokens-limit": "12000000",
  "anthropic-ratelimit-tokens-remaining": "12000000",
  "anthropic-ratelimit-tokens-reset": "2026-08-16T10:28:32Z",
});

describe("parseRateLimitHeaders", () => {
  // Mistral is the reason the pacer exists: a 4-per-minute ceiling, and the only vendor that prices
  // the call for us. It is also the only one with no reset, which is what forces a learned recovery.
  it("reads Mistral's per-minute ceilings and the cost of the call just made", () => {
    expect(parseRateLimitHeaders(MISTRAL, NOW)).toEqual({
      limitRequests: 4,
      remainingRequests: 3,
      limitTokens: 250_000,
      remainingTokens: 243_582,
      queryCost: 6416,
    });
  });

  it("reads OpenAI's ceilings and turns its duration reset into an instant", () => {
    expect(parseRateLimitHeaders(OPENAI, NOW)).toEqual({
      limitRequests: 5_000,
      remainingRequests: 4_999,
      limitTokens: 2_000_000,
      remainingTokens: 1_999_997,
      resetRequestsAt: NOW + 12,
      resetTokensAt: NOW,
    });
  });

  it("keeps Scaleway's request and token reset clocks separate", () => {
    expect(parseRateLimitHeaders(SCALEWAY, NOW)).toEqual({
      limitRequests: 300,
      remainingRequests: 149,
      limitTokens: 200_000,
      remainingTokens: 99_987,
      resetRequestsAt: NOW + 200,
      resetTokensAt: NOW + 3,
    });
  });

  it("reads Anthropic's ceilings and its ISO reset", () => {
    expect(parseRateLimitHeaders(ANTHROPIC, NOW)).toEqual({
      limitRequests: 10_000,
      remainingRequests: 9_999,
      limitTokens: 12_000_000,
      remainingTokens: 12_000_000,
      resetRequestsAt: Date.parse("2026-08-16T10:28:31Z"),
      resetTokensAt: Date.parse("2026-08-16T10:28:32Z"),
    });
  });

  // DeepSeek and Moonshot report nothing. Null rather than zeroes: a bucket that believes it has no
  // quota left would stall a provider that was never throttling in the first place.
  it("returns null when a response says nothing about rate limits", () => {
    expect(parseRateLimitHeaders(new Headers({ "content-type": "application/json" }), NOW)).toBeNull();
  });

  // Measured: Mistral's own 429s carry no rate-limit headers at all, so retry-after is the only
  // thing a refusal can teach us, and it has to survive on its own.
  it("reads a bare retry-after when nothing else is present", () => {
    expect(parseRateLimitHeaders(new Headers({ "retry-after": "30" }), NOW)).toEqual({ retryAt: NOW + 30_000 });
  });

  it("keeps retry-after as a response-wide override without discarding either reset clock", () => {
    const headers = new Headers(OPENAI);
    headers.set("retry-after", "5");
    expect(parseRateLimitHeaders(headers, NOW)).toMatchObject({
      retryAt: NOW + 5_000,
      resetRequestsAt: NOW + 12,
      resetTokensAt: NOW,
    });
  });

  it("keeps a partial header set rather than discarding what was reported", () => {
    expect(parseRateLimitHeaders(new Headers({ "x-ratelimit-remaining-req-minute": "2" }), NOW)).toEqual({
      remainingRequests: 2,
    });
  });

  it("ignores values that are not counts", () => {
    const headers = new Headers({
      "x-ratelimit-limit-req-minute": "unlimited",
      "x-ratelimit-remaining-req-minute": "2",
    });
    expect(parseRateLimitHeaders(headers, NOW)).toEqual({ remainingRequests: 2 });
  });
});

describe("parseResetDuration", () => {
  it.each([
    ["12ms", 12],
    ["0s", 0],
    ["6m0s", 360_000],
    ["1m30s", 90_000],
    ["2h", 7_200_000],
  ])("reads %s as %ims", (raw, expected) => {
    expect(parseResetDuration(raw)).toBe(expected);
  });

  it("returns undefined for a value carrying no units", () => {
    expect(parseResetDuration("soon")).toBeUndefined();
  });
});
