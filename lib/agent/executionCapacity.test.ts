import { describe, expect, it } from "vitest";
import {
  DEFAULT_MAX_CONCURRENT_AGENT_RUNS,
  ExecutionCapacity,
  executionCapacityMessage,
  parseExecutionCapacity,
} from "./executionCapacity";

describe("execution capacity", () => {
  it("defaults invalid or missing configuration to the conservative ceiling", () => {
    expect(parseExecutionCapacity(undefined)).toBe(DEFAULT_MAX_CONCURRENT_AGENT_RUNS);
    expect(parseExecutionCapacity("0")).toBe(DEFAULT_MAX_CONCURRENT_AGENT_RUNS);
    expect(parseExecutionCapacity("many")).toBe(DEFAULT_MAX_CONCURRENT_AGENT_RUNS);
    expect(parseExecutionCapacity("12")).toBe(12);
  });

  it("rejects the next run at the limit and recovers a slot exactly once", () => {
    const capacity = new ExecutionCapacity(2);
    const first = capacity.tryAcquire();
    const second = capacity.tryAcquire();

    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(capacity.tryAcquire()).toBeNull();
    expect(capacity.snapshot()).toEqual({ active: 2, limit: 2, available: 0, atCapacity: true });
    expect(executionCapacityMessage(capacity.snapshot())).toContain("2/2 agent runs are active");

    first!.release();
    first!.release();
    expect(capacity.snapshot().active).toBe(1);
    expect(capacity.tryAcquire()).not.toBeNull();
  });
});
