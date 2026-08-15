// The preflight is the whole of "fail hard in the conversation": it runs before a container is
// warmed or a byte is sent, and its message is the only thing the operator will see. These pin that
// the two locally-known causes stay distinguishable, because after a purge they look identical from
// the key store — a switched-off provider has no key either.
import { describe, it, expect } from "vitest";
import { TERMINAL_PROVIDER_CODES, isTerminalProviderCode, preflightProviderFailure } from "./providerFailure";

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

  // The distinction that earns the second code. Both cases end with no key in the store — the purge
  // deletes a withdrawn provider's key at startup — so reporting the consequence would send this
  // operator to a form that will not list the provider, to fix something that is not broken.
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
      "PROVIDER_CREDIT_EXHAUSTED",
      "PROVIDER_KEY_INVALID",
      "PROVIDER_KEY_MISSING",
      "PROVIDER_UNAVAILABLE",
    ]);
  });

  // The list exists so executeSkill and agentCall stop retrying on all four rather than the two that
  // predate BYOK. A code missing from it is a sub-agent retrying a missing API key forever, at cost.
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
