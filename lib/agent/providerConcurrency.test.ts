// The counter a future limit will be set against. Every assertion here is about it staying honest:
// an undercount lets traffic through a ceiling, an overcount throttles calls that should have gone.
import { describe, it, expect } from "vitest";
import { ProviderConcurrency, providerConcurrency } from "./providerConcurrency";

describe("ProviderConcurrency", () => {
  it("reports an untouched provider as idle rather than unknown", () => {
    expect(new ProviderConcurrency().snapshot("mistral")).toEqual({
      provider: "mistral",
      active: 0,
      peak: 0,
      total: 0,
    });
  });

  it("counts calls in flight and remembers the highest it saw", () => {
    const counter = new ProviderConcurrency();
    const a = counter.enter("mistral");
    const b = counter.enter("mistral");
    expect(counter.snapshot("mistral")).toMatchObject({ active: 2, peak: 2, total: 2 });

    a();
    b();
    expect(counter.snapshot("mistral")).toMatchObject({ active: 0, peak: 2, total: 2 });

    counter.enter("mistral");
    expect(counter.snapshot("mistral")).toMatchObject({ active: 1, peak: 2, total: 3 });
  });

  // A stream can both throw and be abandoned; the gateway calls release on each path.
  it("ignores a repeated release instead of counting below zero", () => {
    const counter = new ProviderConcurrency();
    const release = counter.enter("mistral");
    release();
    release();
    expect(counter.snapshot("mistral").active).toBe(0);
  });

  it("keeps providers apart, since each has its own quota", () => {
    const counter = new ProviderConcurrency();
    counter.enter("mistral");
    counter.enter("anthropic");
    counter.enter("anthropic");

    expect(counter.snapshot("mistral").active).toBe(1);
    expect(counter.snapshot("anthropic").active).toBe(2);
    expect(
      counter
        .all()
        .map((s) => s.provider)
        .sort(),
    ).toEqual(["anthropic", "mistral"]);
  });

  // Sub-agent runs build their own gateway. If each got its own counter, fan-out would multiply any
  // ceiling by the number of concurrent runs — the case the shared quota exists to catch.
  it("is one instance for the whole process", () => {
    expect(providerConcurrency).toBe(
      (global as typeof global & { __singletons: Record<string, unknown> }).__singletons.agentProviderConcurrency,
    );
  });
});
