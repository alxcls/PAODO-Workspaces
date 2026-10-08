import { describe, it, expect } from "vitest";
import { formatTokens, formatSessionCost, formatRunError, originLabel } from "./usageSessions";

describe("formatRunError", () => {
  it("prefixes the code when there is one", () =>
    expect(formatRunError({ code: "TIMEOUT", message: "too slow" })).toBe("[TIMEOUT] too slow"));
  it("shows the bare message otherwise", () => expect(formatRunError({ message: "too slow" })).toBe("too slow"));
});

describe("formatTokens", () => {
  it("shows an em-dash for zero", () => expect(formatTokens(0)).toBe("—"));
  it("passes sub-1000 through as-is", () => expect(formatTokens(742)).toBe("742"));
  it("abbreviates thousands", () => expect(formatTokens(1500)).toBe("1.5K"));
});

// The precision rules, reached through the function the dashboard actually calls. A run's cost is
// often sub-cent, so a flat 2 decimals would render most of them as "$0.00".
describe("formatSessionCost", () => {
  const usd = (cost: number) => formatSessionCost({ cost, costByCurrency: { USD: cost } });

  it("shows $0 for exactly zero", () => expect(usd(0)).toBe("$0"));
  it("gives sub-cent amounts extra precision", () => expect(usd(0.0012)).toBe("$0.0012"));
  it("uses 3 decimals under $1", () => expect(usd(0.25)).toBe("$0.250"));
  it("uses 2 decimals at or above $1", () => expect(usd(4.2)).toBe("$4.20"));
  it("carries the euro symbol through the same rules", () =>
    expect(formatSessionCost({ cost: 0.0084, costByCurrency: { EUR: 0.0084 } })).toBe("€0.0084"));
  // The failure this prevents: €0.20 + $0.10 rendered as "0.30" of nothing in particular.
  it("joins mixed-currency subtotals rather than summing them", () =>
    expect(formatSessionCost({ cost: undefined, costByCurrency: { EUR: 0.2, USD: 0.1 } })).toBe("€0.200 + $0.100"));
  it("shows an unpriced run as a dash, never as a zero", () =>
    expect(formatSessionCost({ cost: undefined, costByCurrency: {} })).toBe("—"));
});

describe("originLabel", () => {
  it("maps legacy 'manual' to the chat label", () => expect(originLabel("manual")).toBe("Workspace chat"));
  it("labels the agent graph origin", () => expect(originLabel("agent")).toBe("Agent graph"));
});
