import { describe, it, expect, vi } from "vitest";
import type { BaseMessage } from "@langchain/core/messages";
import type { AgentEvent, RunAgentOptions } from "./runner";
import * as broker from "./runBroker";
import { ExecutionCapacity, ExecutionCapacityReachedError } from "./executionCapacity";

const tick = () => new Promise((r) => setTimeout(r, 0));

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

// Minimal StartRunParams with the disk/usage/services seams stubbed out.
let counter = 0;
function params(
  run: typeof import("./runner").runAgent,
  extra: Partial<broker.StartRunParams> = {},
): broker.StartRunParams {
  const n = counter++;
  return {
    workspaceId: `ws-${n}`,
    workspaceName: "test",
    workspaceDir: "/tmp",
    conversationId: `conv-${n}`,
    messages: [] as BaseMessage[],
    userInput: "go",
    maxIterations: 5,
    run,
    onTurnUsage: vi.fn(),
    onRunError: vi.fn(),
    onPersist: vi.fn(),
    ...extra,
    maxRunMinutes: extra.maxRunMinutes ?? 5,
  };
}

describe("runBroker", () => {
  it("replays buffered events to a late subscriber, then streams live ones", async () => {
    const gate = deferred();
    const run = async function* () {
      yield { type: "token", content: "a" } as AgentEvent;
      await gate.promise;
      yield { type: "done" } as AgentEvent;
    } as unknown as typeof import("./runner").runAgent;

    const p = params(run);
    broker.startRun(p);
    await tick(); // let the first token land in the buffer

    const received: AgentEvent[] = [];
    const sub = broker.subscribe(p.workspaceId, p.conversationId, (e) => received.push(e));
    expect(sub).not.toBeNull();
    expect(sub!.replay).toEqual([{ type: "token", content: "a" }]);
    expect(sub!.userInput).toBe("go");

    gate.resolve();
    await tick();
    expect(received).toContainEqual({ type: "done" });
    expect(p.onPersist).toHaveBeenCalledOnce();
  });

  it("fans the same live events out to multiple subscribers", async () => {
    const gate = deferred();
    const run = async function* () {
      await gate.promise;
      yield { type: "token", content: "x" } as AgentEvent;
      yield { type: "done" } as AgentEvent;
    } as unknown as typeof import("./runner").runAgent;

    const p = params(run);
    broker.startRun(p);
    const a: AgentEvent[] = [];
    const b: AgentEvent[] = [];
    broker.subscribe(p.workspaceId, p.conversationId, (e) => a.push(e));
    broker.subscribe(p.workspaceId, p.conversationId, (e) => b.push(e));

    gate.resolve();
    await tick();
    expect(a).toEqual([{ type: "token", content: "x" }, { type: "done" }]);
    expect(b).toEqual(a);
  });

  it("rejects a second run for the same conversation, and stop() aborts the first", async () => {
    const run = async function* (_m: unknown, _u: unknown, _d: unknown, _id: unknown, opts: RunAgentOptions) {
      await new Promise<void>((res) => {
        if (opts.signal?.aborted) return res();
        opts.signal?.addEventListener("abort", () => res());
      });
      yield { type: "error", message: "AbortError: This operation was aborted" } as AgentEvent;
      yield { type: "done" } as AgentEvent;
    } as unknown as typeof import("./runner").runAgent;

    const p = params(run);
    expect(broker.startRun(p).alreadyRunning).toBe(false);
    expect(broker.isRunning(p.workspaceId, p.conversationId)).toBe(true);
    expect(broker.startRun(p).alreadyRunning).toBe(true);
    const received: AgentEvent[] = [];
    broker.subscribe(p.workspaceId, p.conversationId, (event) => received.push(event));

    expect(broker.stop(p.workspaceId, p.conversationId)).toBe(true);
    await tick();
    expect(broker.isRunning(p.workspaceId, p.conversationId)).toBe(false);
    expect(received).toEqual([
      { type: "error", code: "CANCELLED", message: "Conversation stopped by the user." },
      { type: "done" },
    ]);
    expect(p.onRunError).toHaveBeenCalledWith(expect.any(String), {
      code: "CANCELLED",
      message: "Conversation stopped by the user.",
    });
  });

  it("emits a stable timeout error before done when the workspace limit expires", async () => {
    const run = async function* (_m: unknown, _u: unknown, _d: unknown, _id: unknown, opts: RunAgentOptions) {
      await new Promise<void>((resolve) => {
        if (opts.signal?.aborted) return resolve();
        opts.signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      yield { type: "error", message: "AbortError: provider request aborted" } as AgentEvent;
      yield { type: "done" } as AgentEvent;
    } as unknown as typeof import("./runner").runAgent;

    const p = params(run, { workspaceName: "Slow workspace", maxRunMinutes: 0.001 });
    broker.startRun(p);
    const received: AgentEvent[] = [];
    broker.subscribe(p.workspaceId, p.conversationId, (event) => received.push(event));

    await new Promise((resolve) => setTimeout(resolve, 90));

    expect(received).toEqual([
      {
        type: "error",
        code: "TIMEOUT",
        message: 'Workspace "Slow workspace" exceeded its 0.001-minute execution limit.',
      },
      { type: "done" },
    ]);
    expect(p.onRunError).toHaveBeenCalledWith(expect.any(String), {
      code: "TIMEOUT",
      message: 'Workspace "Slow workspace" exceeded its 0.001-minute execution limit.',
    });
  });

  it("returns null when subscribing to a conversation with no run", () => {
    expect(broker.subscribe("nope", "nope", () => {})).toBeNull();
    expect(broker.isRunning("nope", "nope")).toBe(false);
  });

  it("rejects the next top-level run at capacity and releases the slot when a run ends", async () => {
    const capacity = new ExecutionCapacity(1);
    const gate = deferred();
    const run = async function* () {
      await gate.promise;
      yield { type: "done" } as AgentEvent;
    } as unknown as typeof import("./runner").runAgent;
    const first = params(run, { capacity });
    const rejected = params(run, { capacity });

    expect(broker.startRun(first)).toEqual({ alreadyRunning: false });
    expect(broker.startRun(rejected)).toEqual({
      alreadyRunning: false,
      capacityReached: { active: 1, limit: 1, available: 0, atCapacity: true },
    });

    gate.resolve();
    await tick();
    expect(broker.startRun(rejected)).toEqual({ alreadyRunning: false });
    await tick();
  });

  describe("startExternalRun", () => {
    it("buffers + fans out producer-published events, and marks the conversation running", () => {
      const ext = broker.startExternalRun("ws-ext", "conv-ext", "hello");
      expect(ext).not.toBeNull();
      expect(broker.isRunning("ws-ext", "conv-ext")).toBe(true);
      expect(broker.runningConversationIds("ws-ext")).toContain("conv-ext");

      // Event published before anyone subscribes is replayed on attach.
      ext!.publish({ type: "token", content: "a" });
      const received: AgentEvent[] = [];
      const sub = broker.subscribe("ws-ext", "conv-ext", (e) => received.push(e));
      expect(sub).not.toBeNull();
      expect(sub!.replay).toEqual([{ type: "token", content: "a" }]);
      expect(sub!.userInput).toBe("hello");

      // Subsequent events stream live to the subscriber.
      ext!.publish({ type: "token", content: "b" });
      expect(received).toEqual([{ type: "token", content: "b" }]);

      ext!.publish({ type: "done" });
      ext!.finish();
      expect(broker.isRunning("ws-ext", "conv-ext")).toBe(false);
    });

    it("rejects a second external run for a conversation already running", () => {
      const first = broker.startExternalRun("ws-ext2", "conv-ext2", "x");
      expect(first).not.toBeNull();
      expect(broker.startExternalRun("ws-ext2", "conv-ext2", "x")).toBeNull();
      first!.finish();
    });

    it("exposes a signal that stop() aborts, so a Stop on the callee's own tab halts its runner", () => {
      const ext = broker.startExternalRun("ws-ext3", "conv-ext3", "x");
      expect(ext).not.toBeNull();
      expect(ext!.signal.aborted).toBe(false);

      expect(broker.stop("ws-ext3", "conv-ext3")).toBe(true);
      expect(ext!.signal.aborted).toBe(true);
      ext!.finish();
    });

    it("returns a capacity error to an external agent caller and recovers after finish", () => {
      const capacity = new ExecutionCapacity(1);
      const first = broker.startExternalRun("ws-cap", "conv-cap-1", "x", { capacity });

      expect(() => broker.startExternalRun("ws-cap", "conv-cap-2", "x", { capacity })).toThrow(
        ExecutionCapacityReachedError,
      );
      first!.finish();
      const next = broker.startExternalRun("ws-cap", "conv-cap-2", "x", { capacity });
      expect(next).not.toBeNull();
      next!.finish();
    });
  });
});
