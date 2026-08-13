// The wordings pinned here are the ones observed in production or documented by each provider.
// A provider that changes its phrasing must fail these tests, not silently stop being recognized.

import { beforeEach, describe, expect, it } from "vitest";
import { resetLogThrottle } from "../infra/logThrottle";
import {
  classifyProviderCreditExhaustion,
  providerCreditExhaustedMessage,
  reportProviderCreditExhaustion,
} from "./providerCreditFailure";

beforeEach(() => resetLogThrottle());

// Shaped like a LangChain-wrapped provider error: status and machine code on the outer object,
// the prose repeated on a nested `error`.
function providerError(message: string, status?: number, code?: string) {
  return Object.assign(new Error(message), {
    ...(status === undefined ? {} : { status }),
    ...(code === undefined ? {} : { code }),
    error: { message: message.replace(/^\d{3} /, ""), code },
  });
}

describe("provider credit exhaustion", () => {
  it("classifies DeepSeek's 402, keeping the provider's own wording", () => {
    expect(
      classifyProviderCreditExhaustion(providerError("402 Insufficient Balance", 402, "invalid_request_error")),
    ).toEqual({
      failureClass: "credit_exhaustion",
      failureCode: "PROVIDER_CREDIT_EXHAUSTED",
      resource: "llm_provider_credit_balance",
      resourceScope: "llm_provider_account",
      retryable: false,
      status: 402,
      providerMessage: "402 Insufficient Balance",
    });
  });

  it("classifies the balance-derived 429 DeepSeek sends before the account is fully dry", () => {
    const err = providerError(
      "429 Too many requests. Your current concurrency is 17, which exceeds your concurrency limit of 17 " +
        "based on your remaining balance. Please top up your balance to restore your concurrency.\n\n" +
        "Troubleshooting URL: https://docs.langchain.com/oss/javascript/langchain/errors/MODEL_RATE_LIMIT/\n",
      429,
      "invalid_request_error",
    );

    const failure = classifyProviderCreditExhaustion(err);

    expect(failure?.failureCode).toBe("PROVIDER_CREDIT_EXHAUSTED");
    expect(failure?.status).toBe(429);
    // First line only — the appended troubleshooting URL is not part of the explanation.
    expect(failure?.providerMessage).not.toContain("Troubleshooting URL");
  });

  it("classifies the other providers' equivalents", () => {
    const wordings = [
      // Anthropic
      providerError("400 Your credit balance is too low to access the Anthropic API", 400, "invalid_request_error"),
      // OpenAI
      providerError(
        "429 You exceeded your current quota, please check your plan and billing details",
        429,
        "insufficient_quota",
      ),
      // Moonshot
      providerError("Your account org-1 is not active, please check your account balance", 401),
    ];

    expect(wordings.map((err) => classifyProviderCreditExhaustion(err)?.failureCode)).toEqual([
      "PROVIDER_CREDIT_EXHAUSTED",
      "PROVIDER_CREDIT_EXHAUSTED",
      "PROVIDER_CREDIT_EXHAUSTED",
    ]);
  });

  it("leaves ordinary throttling and unrelated failures alone", () => {
    // A funded account's 429 has no balance wording — misreading it as an empty account would tell
    // the user to top up when they only need to wait.
    expect(classifyProviderCreditExhaustion(providerError("429 Rate limit reached for gpt-5", 429))).toBeNull();
    expect(classifyProviderCreditExhaustion(providerError("401 Incorrect API key provided", 401))).toBeNull();
    expect(classifyProviderCreditExhaustion(new Error("terminated"))).toBeNull();
    expect(classifyProviderCreditExhaustion(undefined)).toBeNull();
  });

  it("names the account, the model and the way out", () => {
    const failure = classifyProviderCreditExhaustion("402 Insufficient Balance")!;

    const message = providerCreditExhaustedMessage(failure, { provider: "deepseek", model: "deepseek-chat" });

    expect(message).toContain("deepseek account has run out of credit");
    expect(message).toContain("402 Insufficient Balance");
    expect(message).toContain("topped up");
    // Reachable from the limit-synthesis path, which knows the model but not the provider.
    expect(providerCreditExhaustedMessage(failure, { model: "deepseek-chat" })).toContain(
      "The model provider account has run out of credit",
    );
  });

  it("collapses the burst of identical failures one dry account causes across workspaces", () => {
    const records: Array<Record<string, unknown>> = [];
    const logger = { error: (bindings: Record<string, unknown>) => void records.push(bindings) };
    const err = providerError("402 Insufficient Balance", 402);
    const context = { workspaceId: "ws-1", provider: "deepseek", model: "deepseek-chat", stage: "model_turn" };

    // 20 workspaces failing within the same window; every call still returns the classification, so
    // every run can explain itself even when its log line is suppressed.
    const classified = Array.from({ length: 20 }, (_, i) =>
      reportProviderCreditExhaustion(logger, err, { ...context, workspaceId: `ws-${i}` }, 1_000),
    );
    reportProviderCreditExhaustion(logger, err, context, 12_000);

    expect(classified.every((failure) => failure?.failureCode === "PROVIDER_CREDIT_EXHAUSTED")).toBe(true);
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({ event: "provider_credit_exhausted", provider: "deepseek", suppressed: 0 });
    expect(records[1]).toMatchObject({ suppressed: 19 });
  });

  it("reports nothing for a failure that is not about credit", () => {
    const logger = { error: () => expect.unreachable("must not log") };
    expect(
      reportProviderCreditExhaustion(logger, new Error("socket hang up"), { workspaceId: "ws-1", stage: "x" }),
    ).toBeNull();
  });
});
