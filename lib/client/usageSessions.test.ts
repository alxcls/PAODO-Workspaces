import { describe, it, expect } from "vitest";
import type { LightTurnRecord } from "../workspace/usageStore";
import { groupBySessions, formatTokens, formatCost, originLabel } from "./usageSessions";

function rec(over: Partial<LightTurnRecord> = {}): LightTurnRecord {
  return {
    id: "r1",
    sessionId: "s1",
    workspaceId: "w1",
    workspaceName: "Alpha",
    timestamp: "2026-01-01T00:00:00.000Z",
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    cachedInputTokens: 0,
    cacheCreationTokens: 0,
    toolCalls: [],
    ...over,
  };
}

describe("groupBySessions", () => {
  it("folds every turn of a run into one row, summing token + tool totals", () => {
    const sessions = groupBySessions([
      rec({
        id: "a",
        inputTokens: 100,
        outputTokens: 10,
        cachedInputTokens: 5,
        toolCalls: [{ name: "glob", status: "ok" }],
      }),
      rec({
        id: "b",
        inputTokens: 50,
        outputTokens: 20,
        cachedInputTokens: 5,
        toolCalls: [
          { name: "exec", status: "error" },
          { name: "read", status: "ok" },
        ],
      }),
    ]);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      sessionId: "s1",
      inputTokens: 150,
      outputTokens: 30,
      cachedInputTokens: 10,
      toolTotal: 3,
    });
  });

  it("collects distinct models in first-seen order", () => {
    const [s] = groupBySessions([
      rec({ id: "a", model: "gpt-x" }),
      rec({ id: "b", model: "claude-y" }),
      rec({ id: "c", model: "gpt-x" }),
    ]);
    expect(s.models).toEqual(["gpt-x", "claude-y"]);
  });

  it("defaults a missing origin to 'manual'", () => {
    const [s] = groupBySessions([rec({ origin: undefined })]);
    expect(s.origin).toBe("manual");
  });

  it("uses the earliest turn timestamp as the session start", () => {
    const [s] = groupBySessions([
      rec({ id: "a", timestamp: "2026-01-01T00:05:00.000Z" }),
      rec({ id: "b", timestamp: "2026-01-01T00:01:00.000Z" }),
    ]);
    expect(s.timestamp).toBe("2026-01-01T00:01:00.000Z");
  });

  it("orders sessions newest-started first", () => {
    const sessions = groupBySessions([
      rec({ sessionId: "old", timestamp: "2026-01-01T00:00:00.000Z" }),
      rec({ sessionId: "new", timestamp: "2026-01-02T00:00:00.000Z" }),
    ]);
    expect(sessions.map((s) => s.sessionId)).toEqual(["new", "old"]);
  });

  it("does not re-price a historical turn whose stored cost is absent", () => {
    const [s] = groupBySessions([rec({ model: "chatgpt-4o-latest" })]);
    expect(s.cost).toBeUndefined();
  });

  it("uses the cost frozen by the usage store", () => {
    const [s] = groupBySessions([rec({ model: "not-a-real-model", cost: 0.123 })]);
    expect(s.cost).toBe(0.123);
  });
});

describe("formatTokens", () => {
  it("shows an em-dash for zero", () => expect(formatTokens(0)).toBe("—"));
  it("passes sub-1000 through as-is", () => expect(formatTokens(742)).toBe("742"));
  it("abbreviates thousands", () => expect(formatTokens(1500)).toBe("1.5K"));
});

describe("formatCost", () => {
  it("shows an em-dash for undefined (no pricing)", () => expect(formatCost(undefined)).toBe("—"));
  it("shows $0 for exactly zero", () => expect(formatCost(0)).toBe("$0"));
  it("gives sub-cent amounts extra precision", () => expect(formatCost(0.0012)).toBe("$0.0012"));
  it("uses 3 decimals under $1", () => expect(formatCost(0.25)).toBe("$0.250"));
  it("uses 2 decimals at or above $1", () => expect(formatCost(4.2)).toBe("$4.20"));
});

describe("originLabel", () => {
  it("maps legacy 'manual' to the chat label", () => expect(originLabel("manual")).toBe("Workspace chat"));
  it("labels the agent network origin", () => expect(originLabel("agent")).toBe("Agent network"));
});
