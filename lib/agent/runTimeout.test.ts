import { afterEach, describe, expect, it, vi } from "vitest";
import { createWorkspaceRunTimeout, WorkspaceRunTimeoutError } from "./runTimeout";

afterEach(() => vi.useRealTimers());

describe("workspace run timeout", () => {
  it("aborts with a stable workspace-specific timeout reason", () => {
    vi.useFakeTimers();
    const timeout = createWorkspaceRunTimeout({ id: "w1", name: "Research", maxRunMinutes: 12 });

    vi.advanceTimersByTime(12 * 60_000);

    expect(timeout.didTimeout()).toBe(true);
    expect(timeout.signal.aborted).toBe(true);
    expect(timeout.signal.reason).toBeInstanceOf(WorkspaceRunTimeoutError);
    expect(timeout.error.message).toBe('Workspace "Research" exceeded its 12-minute execution limit.');
    timeout.dispose();
  });

  it("preserves a parent cancellation without classifying it as this workspace timing out", () => {
    vi.useFakeTimers();
    const parent = new AbortController();
    const timeout = createWorkspaceRunTimeout({ id: "w2", name: "Child", maxRunMinutes: 5 }, [parent.signal]);

    parent.abort();

    expect(timeout.signal.aborted).toBe(true);
    expect(timeout.didTimeout()).toBe(false);
    timeout.dispose();
  });
});
