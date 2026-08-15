// A rejected key has to be told apart from every other 4xx, in both directions: miss it and the
// operator sees `String(err)` and no idea which of five providers refused what; over-match it and
// someone is told to replace a key that was never the problem.
import { describe, it, expect, vi } from "vitest";
import {
  classifyProviderAuthFailure,
  providerKeyInvalidMessage,
  reportProviderAuthFailure,
} from "./providerAuthFailure";
import { classifyProviderCreditExhaustion } from "./providerCreditFailure";

// The shape each SDK actually throws — an object with a status, and the meaning split between
// `message` and a machine `code`/`type` depending on the vendor.
const providerError = (fields: Record<string, unknown>) => fields;

describe("classifyProviderAuthFailure", () => {
  it.each([
    ["anthropic", { status: 401, message: "invalid x-api-key", type: "authentication_error" }],
    ["openai", { status: 401, message: "Incorrect API key provided: sk-abc***", code: "invalid_api_key" }],
    ["deepseek", { status: 401, message: "Authentication Fails, Your api key is invalid" }],
    ["mistral", { status: 401, message: "Unauthorized" }],
    ["moonshot", { status: 401, error: { message: "Invalid Authentication", type: "invalid_api_key" } }],
  ])("recognizes %s's rejected-key response", (_vendor, error) => {
    expect(classifyProviderAuthFailure(providerError(error))).toMatchObject({
      failureCode: "PROVIDER_KEY_INVALID",
      retryable: false,
    });
  });

  it("recognizes the wording even when no status came through", () => {
    // LangChain sometimes wraps the vendor error and loses the status on the way.
    expect(classifyProviderAuthFailure(new Error("401 invalid_api_key: Incorrect API key provided"))).not.toBeNull();
  });

  it.each([
    ["an ordinary 400 about the request body", { status: 400, message: "model does not support tools" }],
    ["a 404 for an unknown model", { status: 404, message: "The model `gpt-9` does not exist" }],
    ["a 429 rate limit", { status: 429, message: "Rate limit reached for requests" }],
    ["a 500 from the provider", { status: 500, message: "internal server error" }],
    ["a network failure", new Error("fetch failed")],
  ])("does not mistake %s for a bad key", (_label, error) => {
    expect(classifyProviderAuthFailure(error)).toBeNull();
  });

  // The one overlap that matters. Several providers answer a dry account with 401 rather than 402,
  // and "replace your key" sends that operator to fix something that is not broken. Both call sites
  // classify credit FIRST for this reason; the assertion here is that the ambiguity is real, so the
  // ordering is load-bearing rather than incidental.
  it("also matches a dry-account 401, which is why credit is classified first", () => {
    const dryAccount = { status: 401, message: "Your credit balance is too low to access the API" };
    expect(classifyProviderAuthFailure(dryAccount)).not.toBeNull();
    expect(classifyProviderCreditExhaustion(dryAccount)).not.toBeNull();
  });

  it("bounds the quoted provider message so an HTML error page cannot flood the transcript", () => {
    const failure = classifyProviderAuthFailure({ status: 401, message: "x".repeat(500) });
    expect(failure!.providerMessage.length).toBeLessThanOrEqual(200);
  });

  it("quotes only the first line, dropping LangChain's appended troubleshooting URL", () => {
    const failure = classifyProviderAuthFailure(
      new Error("401 Unauthorized\nTroubleshooting: https://js.langchain.com"),
    );
    expect(failure!.providerMessage).toBe("401 Unauthorized");
  });
});

describe("providerKeyInvalidMessage", () => {
  it("names the provider and where the key is replaced", () => {
    const failure = classifyProviderAuthFailure({ status: 401, message: "invalid x-api-key" })!;
    const message = providerKeyInvalidMessage(failure, { provider: "anthropic" });
    expect(message).toContain("anthropic");
    expect(message).toContain("Settings");
    // The provider's own words are what distinguish "wrong key" from "revoked key" in practice.
    expect(message).toContain("invalid x-api-key");
  });

  it("stays readable when the provider is unknown", () => {
    const failure = classifyProviderAuthFailure({ status: 401, message: "Unauthorized" })!;
    expect(providerKeyInvalidMessage(failure)).toContain("the model provider");
  });
});

describe("reportProviderAuthFailure", () => {
  it("logs once and returns the classification", () => {
    const logger = { error: vi.fn() };
    const failure = reportProviderAuthFailure(
      logger,
      { status: 401, message: "invalid x-api-key" },
      { workspaceId: "ws-1", provider: "anthropic", stage: "model_turn" },
      1_000_000,
    );

    expect(failure).toMatchObject({ failureCode: "PROVIDER_KEY_INVALID" });
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.error.mock.calls[0][0]).toMatchObject({ event: "provider_key_invalid", provider: "anthropic" });
  });

  it("stays silent, and logs nothing, for an error that is not an auth failure", () => {
    const logger = { error: vi.fn() };
    expect(
      reportProviderAuthFailure(logger, new Error("boom"), { workspaceId: "ws-1", stage: "model_turn" }),
    ).toBeNull();
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("collapses a burst so one bad key cannot rotate the log", () => {
    // A bad key fails every workspace pointed at that provider within seconds. Per-run attribution is
    // not lost — each run still records its own error; this is only the account-level report.
    const logger = { error: vi.fn() };
    const error = { status: 401, message: "invalid x-api-key" };
    const context = { workspaceId: "ws-1", provider: "openai", stage: "model_turn" };
    for (let i = 0; i < 5; i++) reportProviderAuthFailure(logger, error, context, 2_000_000 + i);
    expect(logger.error.mock.calls.length).toBeLessThan(5);
  });
});
