// The wordings pinned here are the ones observed in production. A provider that changes its
// phrasing must fail these tests, not silently stop being recognized.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetLogThrottle } from "../infra/logThrottle";
import {
  CLASSIFIED_PROVIDER_FAILURES,
  TERMINAL_PROVIDER_CODES,
  classifyProviderFailure,
  isTerminalProviderCode,
  preflightProviderFailure,
  providerFailureMessage,
  reportProviderFailure,
} from "./providerFailure";

beforeEach(() => resetLogThrottle());

// Shaped like a LangChain-wrapped provider error: status and machine code on the outer object, the
// prose repeated on a nested `error`.
function wrapped(message: string, status?: number, code?: string) {
  return Object.assign(new Error(message), {
    ...(status === undefined ? {} : { status }),
    ...(code === undefined ? {} : { code }),
    error: { message: message.replace(/^\d{3} /, ""), code },
  });
}

// The shape each SDK actually throws — the meaning split between `message` and a machine
// `code`/`type` depending on the vendor.
const raw = (fields: Record<string, unknown>) => fields;

describe("classifyProviderFailure — credit exhaustion", () => {
  it("classifies DeepSeek's 402, keeping the provider's own wording", () => {
    expect(classifyProviderFailure(wrapped("402 Insufficient Balance", 402, "invalid_request_error"))).toEqual({
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
    const failure = classifyProviderFailure(
      wrapped(
        "429 Too many requests. Your current concurrency is 17, which exceeds your concurrency limit of 17 " +
          "based on your remaining balance. Please top up your balance to restore your concurrency.\n\n" +
          "Troubleshooting URL: https://docs.langchain.com/oss/javascript/langchain/errors/MODEL_RATE_LIMIT/\n",
        429,
        "invalid_request_error",
      ),
    );

    expect(failure?.failureCode).toBe("PROVIDER_CREDIT_EXHAUSTED");
    expect(failure?.status).toBe(429);
    // First line only — the appended troubleshooting URL is not part of the explanation.
    expect(failure?.providerMessage).not.toContain("Troubleshooting URL");
  });

  it("classifies the other providers' equivalents", () => {
    const wordings = [
      // Anthropic
      wrapped("400 Your credit balance is too low to access the Anthropic API", 400, "invalid_request_error"),
      // OpenAI
      wrapped(
        "429 You exceeded your current quota, please check your plan and billing details",
        429,
        "insufficient_quota",
      ),
      // Moonshot
      wrapped("Your account org-1 is not active, please check your account balance", 401),
    ];

    expect(wordings.map((error) => classifyProviderFailure(error)?.failureCode)).toEqual([
      "PROVIDER_CREDIT_EXHAUSTED",
      "PROVIDER_CREDIT_EXHAUSTED",
      "PROVIDER_CREDIT_EXHAUSTED",
    ]);
  });
});

describe("classifyProviderFailure — rejected key", () => {
  it.each([
    ["anthropic", { status: 401, message: "invalid x-api-key", type: "authentication_error" }],
    ["openai", { status: 401, message: "Incorrect API key provided: sk-abc***", code: "invalid_api_key" }],
    ["deepseek", { status: 401, message: "Authentication Fails, Your api key is invalid" }],
    ["mistral", { status: 401, message: "Unauthorized" }],
    ["moonshot", { status: 401, error: { message: "Invalid Authentication", type: "invalid_api_key" } }],
  ])("recognizes %s's rejected-key response", (_vendor, error) => {
    expect(classifyProviderFailure(raw(error))).toMatchObject({
      failureCode: "PROVIDER_KEY_INVALID",
      retryable: false,
    });
  });

  it("recognizes the wording even when no status came through", () => {
    // LangChain sometimes wraps the vendor error and loses the status on the way.
    expect(classifyProviderFailure(new Error("401 invalid_api_key: Incorrect API key provided"))).not.toBeNull();
  });
});

// Why this is a table and not three modules: both cases below would match the key-invalid rule on
// their own, and only the credit rule sitting above it keeps them from reaching it.
describe("classifyProviderFailure — precedence", () => {
  it.each([
    ["a dry account answering 401", { status: 401, message: "Your credit balance is too low to access the API" }],
    ["Moonshot's 401 about the account balance", { status: 401, message: "please check your account balance" }],
  ])("reads %s as out of credit, not as a bad key", (_label, error) => {
    expect(classifyProviderFailure(raw(error))?.failureCode).toBe("PROVIDER_CREDIT_EXHAUSTED");
  });

  it("still reads a genuinely rejected key as a rejected key", () => {
    expect(classifyProviderFailure(wrapped("401 Incorrect API key provided", 401))?.failureCode).toBe(
      "PROVIDER_KEY_INVALID",
    );
  });

  // The reason the rate-limit rule sits last: DeepSeek scales concurrency to the remaining balance,
  // so an empty account is announced as a 429 and would otherwise read as ordinary throttling.
  it.each([
    ["DeepSeek's balance-scaled 429", { status: 429, message: "Your remaining balance is insufficient" }],
    ["OpenAI's quota 429", { status: 429, message: "You exceeded your current quota" }],
  ])("reads %s as out of credit, not as throttling", (_label, error) => {
    expect(classifyProviderFailure(raw(error))?.failureCode).toBe("PROVIDER_CREDIT_EXHAUSTED");
  });
});

describe("classifyProviderFailure — rate limiting", () => {
  it("classifies a funded account's 429 as throttling, and says waiting can fix it", () => {
    expect(classifyProviderFailure(raw({ status: 429, message: "Rate limit reached for requests" }))).toEqual({
      failureClass: "rate_limit",
      failureCode: "PROVIDER_RATE_LIMITED",
      resource: "llm_provider_request_quota",
      resourceScope: "llm_provider_account",
      retryable: true,
      status: 429,
      providerMessage: "Rate limit reached for requests",
    });
  });

  it.each([
    ["Mistral", { status: 429, message: "Requests rate limit exceeded" }],
    ["OpenAI's per-minute wording", { status: 429, message: "Limit: 30000 tokens per min (TPM)" }],
    ["OpenAI's shared-pool refusal", { status: 429, message: "service tier capacity exceeded" }],
    ["Anthropic's overload", { status: 529, message: "Overloaded" }],
    ["a bare too-many-requests with no status", raw({ message: "Too Many Requests" })],
  ])("recognizes %s", (_label, error) => {
    expect(classifyProviderFailure(raw(error as Record<string, unknown>))?.failureCode).toBe("PROVIDER_RATE_LIMITED");
  });

  it("does not end the run permanently, unlike every other classified cause", () => {
    expect(isTerminalProviderCode("PROVIDER_RATE_LIMITED")).toBe(false);
    expect(TERMINAL_PROVIDER_CODES).not.toContain("PROVIDER_RATE_LIMITED");
  });
});

describe("classifyProviderFailure — what it leaves alone", () => {
  it.each([
    ["an ordinary 400 about the request body", { status: 400, message: "model does not support tools" }],
    ["a 404 for an unknown model", { status: 404, message: "The model `gpt-9` does not exist" }],
    ["a 500 from the provider", { status: 500, message: "internal server error" }],
    ["a network failure", new Error("fetch failed")],
    ["nothing at all", undefined],
  ])("returns null for %s", (_label, error) => {
    expect(classifyProviderFailure(error)).toBeNull();
  });

  it("bounds the quoted provider message so an HTML error page cannot flood the transcript", () => {
    const failure = classifyProviderFailure(raw({ status: 401, message: "x".repeat(500) }));
    expect(failure!.providerMessage.length).toBeLessThanOrEqual(200);
  });

  it("quotes only the first line, dropping LangChain's appended troubleshooting URL", () => {
    const failure = classifyProviderFailure(new Error("401 Unauthorized\nTroubleshooting: https://js.langchain.com"));
    expect(failure!.providerMessage).toBe("401 Unauthorized");
  });
});

describe("providerFailureMessage", () => {
  it("names the account, the model and the way out for an empty balance", () => {
    const failure = classifyProviderFailure("402 Insufficient Balance")!;

    const message = providerFailureMessage(failure, { provider: "deepseek", model: "deepseek-chat" });

    expect(message).toContain("deepseek account has run out of credit");
    expect(message).toContain("402 Insufficient Balance");
    expect(message).toContain("topped up");
    // Reachable from the limit-synthesis path, which knows the model but not the provider.
    expect(providerFailureMessage(failure, { model: "deepseek-chat" })).toContain(
      "The model provider account has run out of credit",
    );
  });

  it("names the provider and where the key is replaced for a rejected key", () => {
    const failure = classifyProviderFailure(raw({ status: 401, message: "invalid x-api-key" }))!;
    const message = providerFailureMessage(failure, { provider: "anthropic" });
    expect(message).toContain("anthropic");
    expect(message).toContain("Settings");
    // The provider's own words are what distinguish "wrong key" from "revoked key" in practice.
    expect(message).toContain("invalid x-api-key");
  });

  it("stays readable when the provider is unknown", () => {
    const failure = classifyProviderFailure(raw({ status: 401, message: "Unauthorized" }))!;
    expect(providerFailureMessage(failure)).toContain("the model provider");
  });
});

describe("reportProviderFailure", () => {
  it("logs under the rule's own event name and returns the classification", () => {
    const logger = { error: vi.fn() };
    const failure = reportProviderFailure(
      logger,
      raw({ status: 401, message: "invalid x-api-key" }),
      { workspaceId: "ws-1", provider: "anthropic", stage: "model_turn" },
      1_000_000,
    );

    expect(failure).toMatchObject({ failureCode: "PROVIDER_KEY_INVALID" });
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.error.mock.calls[0][0]).toMatchObject({ event: "provider_key_invalid", provider: "anthropic" });
  });

  it("collapses the burst of identical failures one dry account causes across workspaces", () => {
    const records: Array<Record<string, unknown>> = [];
    const logger = { error: (bindings: Record<string, unknown>) => void records.push(bindings) };
    const error = wrapped("402 Insufficient Balance", 402);
    const context = { workspaceId: "ws-1", provider: "deepseek", model: "deepseek-chat", stage: "model_turn" };

    // 20 workspaces failing within the same window; every call still returns the classification, so
    // every run can explain itself even when its log line is suppressed.
    const classified = Array.from({ length: 20 }, (_, i) =>
      reportProviderFailure(logger, error, { ...context, workspaceId: `ws-${i}` }, 1_000),
    );
    reportProviderFailure(logger, error, context, 12_000);

    expect(classified.every((failure) => failure?.failureCode === "PROVIDER_CREDIT_EXHAUSTED")).toBe(true);
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({ event: "provider_credit_exhausted", provider: "deepseek", suppressed: 0 });
    expect(records[1]).toMatchObject({ suppressed: 19 });
  });

  // Each rule throttles on its own event, so a dry account cannot mask a separately broken key.
  it("throttles each cause independently", () => {
    const logger = { error: vi.fn() };
    reportProviderFailure(logger, wrapped("402 Insufficient Balance", 402), { workspaceId: "w", stage: "s" }, 1_000);
    reportProviderFailure(
      logger,
      raw({ status: 401, message: "invalid x-api-key" }),
      { workspaceId: "w", stage: "s" },
      1_000,
    );
    expect(logger.error).toHaveBeenCalledTimes(2);
  });

  it("reports nothing for a failure that is not about the provider", () => {
    const logger = { error: vi.fn() };
    expect(reportProviderFailure(logger, new Error("socket hang up"), { workspaceId: "ws-1", stage: "x" })).toBeNull();
    expect(logger.error).not.toHaveBeenCalled();
  });
});

const OFFERED = ["anthropic", "deepseek"];

describe("preflightProviderFailure", () => {
  it("lets a run proceed when the provider is offered and keyed", () => {
    expect(
      preflightProviderFailure({ provider: "anthropic", model: "claude-haiku-4-5", apiKey: "sk" }, OFFERED),
    ).toBeNull();
  });

  it("stops a run whose provider has no key, and says where to add one", () => {
    const blocked = preflightProviderFailure({ provider: "anthropic", model: "claude-haiku-4-5" }, OFFERED);
    expect(blocked).toMatchObject({ code: "PROVIDER_KEY_MISSING" });
    expect(blocked!.message).toContain("No API key set for anthropic");
    expect(blocked!.message).toContain("Settings");
  });

  it("stops a retired model without silently replacing it", () => {
    const blocked = preflightProviderFailure({ provider: "anthropic", model: "claude-retired", apiKey: "sk" }, OFFERED);
    expect(blocked).toMatchObject({ code: "MODEL_UNAVAILABLE" });
    expect(blocked!.message).toContain("claude-retired");
    expect(blocked!.message).toContain("choose a current model");
  });

  // The distinction that earns the second code: both end with no key in the store, so reporting the
  // consequence sends this operator to a form that will not list the provider.
  it("blames the switch, not the missing key, for a withdrawn provider", () => {
    const blocked = preflightProviderFailure({ provider: "openai", model: "gpt-5.5" }, OFFERED);
    expect(blocked).toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
    expect(blocked!.message).toContain("OPENAI_AVAILABLE=false");
    expect(blocked!.message).not.toContain("No API key set");
  });

  it("still blames the switch when a withdrawn provider somehow still has a key", () => {
    // Reachable between a config change and the restart that purges. The switch is the operator's
    // stated intent, so it wins over a key that is on its way out.
    const blocked = preflightProviderFailure({ provider: "openai", model: "gpt-5.5", apiKey: "sk" }, OFFERED);
    expect(blocked).toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
  });

  it("explains a deployment that offers nothing at all", () => {
    // defaultModelSelection returns an empty provider in this state, so the workspace has no name to
    // report — the message has to describe the deployment rather than the choice.
    const blocked = preflightProviderFailure({ provider: "", model: "" }, []);
    expect(blocked).toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
    expect(blocked!.message).toContain("offers no LLM providers");
  });
});

describe("TERMINAL_PROVIDER_CODES", () => {
  it("covers every way a provider can make a run unrunnable", () => {
    expect([...TERMINAL_PROVIDER_CODES].sort()).toEqual([
      "MODEL_UNAVAILABLE",
      "PROVIDER_CREDIT_EXHAUSTED",
      "PROVIDER_KEY_INVALID",
      "PROVIDER_KEY_MISSING",
      "PROVIDER_UNAVAILABLE",
    ]);
  });

  // Asserted against the rules' own `retryable`, not a second hand-written list: the day a retryable
  // cause is added this keeps holding unedited, and executeSkill/agentCall inherit the change.
  it("holds exactly the causes that waiting cannot fix", () => {
    for (const { code, retryable } of CLASSIFIED_PROVIDER_FAILURES) {
      expect(isTerminalProviderCode(code)).toBe(!retryable);
    }
    // Locally-known failures are unconditional: waiting cannot restore a provider/model or enter a key.
    expect(isTerminalProviderCode("PROVIDER_KEY_MISSING")).toBe(true);
    expect(isTerminalProviderCode("MODEL_UNAVAILABLE")).toBe(true);
    expect(isTerminalProviderCode("PROVIDER_UNAVAILABLE")).toBe(true);
  });

  it("recognizes its own members and nothing else", () => {
    for (const code of TERMINAL_PROVIDER_CODES) expect(isTerminalProviderCode(code)).toBe(true);
    expect(isTerminalProviderCode("EXECUTION_ERROR")).toBe(false);
    expect(isTerminalProviderCode(undefined)).toBe(false);
  });

  it("includes every code the preflight can emit", () => {
    // The preflight's codes and the terminal list are declared separately; this is what keeps a new
    // preflight cause from being retried by callers that consult the list.
    const emitted = [
      preflightProviderFailure({ provider: "anthropic", model: "m" }, OFFERED)!.code,
      preflightProviderFailure({ provider: "openai", model: "m" }, OFFERED)!.code,
      preflightProviderFailure({ provider: "", model: "" }, [])!.code,
    ];
    for (const code of emitted) expect(isTerminalProviderCode(code)).toBe(true);
  });
});
