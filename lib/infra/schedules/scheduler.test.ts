// The scheduler's contract: a due, enabled schedule fires exactly one run through the broker; while
// that run is in flight a second tick does NOT re-fire (reentrancy is tracked here, not by the
// broker, because every fire uses a fresh conversation id); and when the run completes the outcome
// is recorded and nextRunAt advances to a future instant. Broker/agent/services deps are mocked so
// the test exercises the wiring without a live LLM or Docker.
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "scheduler-test-"));
afterAll(() => fs.rmSync(ROOT, { recursive: true, force: true }));

const h = vi.hoisted(() => ({
  startRun: vi.fn(),
  createConversation: vi.fn(),
  subCb: null as null | ((e: { type: string; content?: string; message?: string }) => void),
  unsubscribe: vi.fn(),
  subStatus: "running" as "running" | "done",
}));

vi.mock("../services", () => ({
  getStore: () => ({
    getWorkspace: (id: string) =>
      id === "w1" ? { id: "w1", name: "WS", dir: "/tmp/w1", maxIterations: 10 } : undefined,
  }),
}));
vi.mock("../../agent/runBroker", () => ({
  startRun: (p: unknown) => {
    h.startRun(p);
    return { alreadyRunning: false };
  },
  subscribe: (_w: string, _c: string, cb: (e: { type: string }) => void) => {
    h.subCb = cb;
    return { replay: [], userInput: "", status: h.subStatus, unsubscribe: h.unsubscribe };
  },
}));
vi.mock("../../workspace/conversationStore", () => ({
  createConversation: (workspaceId: string, opts?: { title?: string; kind?: "user" | "skill-call" | "scheduled" }) => {
    h.createConversation(workspaceId, opts);
    return { id: "conv-1" };
  },
  getMessages: () => [],
}));
vi.mock("../../agent/systemPrompt", () => ({ buildSystemPrompt: () => ({}), buildPromptConfig: () => ({}) }));
vi.mock("../../agent/promptContext", () => ({ buildWorkspacePromptInputs: () => ({}) }));
vi.mock("../../agent/buildTools", () => ({ loadAgentConfig: () => ({}) }));
vi.mock("../../agent/messageSerialization", () => ({ setSystemPrompt: () => {} }));

function clearSingletons() {
  delete (global as Record<string, unknown>).__singletons;
}

type StoreMod = typeof import("./scheduleStore");
type SchedMod = typeof import("./scheduler");

let store: StoreMod;
let scheduler: SchedMod;

const past = new Date(Date.now() - 60_000).toISOString();
const future = new Date(Date.now() + 3_600_000).toISOString();

function seed(over: Partial<Parameters<StoreMod["setSchedule"]>[0]> = {}) {
  store.setSchedule({
    id: "s1",
    workspaceId: "w1",
    prompt: "do the thing",
    intervalValue: 1,
    intervalUnit: "hour",
    startAt: "2020-01-01T00:00",
    timezone: "UTC",
    enabled: true,
    createdAt: "2020-01-01T00:00:00.000Z",
    nextRunAt: past,
    ...over,
  });
}

beforeEach(async () => {
  fs.rmSync(ROOT, { recursive: true, force: true });
  fs.mkdirSync(ROOT, { recursive: true });
  process.env.WORKSPACES_ROOT = ROOT;
  h.startRun.mockClear();
  h.createConversation.mockClear();
  h.unsubscribe.mockClear();
  h.subCb = null;
  h.subStatus = "running";
  clearSingletons();
  vi.resetModules();
  store = await import("./scheduleStore");
  scheduler = await import("./scheduler");
});

describe("scheduler tick", () => {
  it("fires a due enabled schedule exactly once and does not re-fire while in flight", () => {
    seed();
    scheduler._tick();
    expect(h.createConversation).toHaveBeenCalledWith("w1", { kind: "scheduled" });
    expect(h.startRun).toHaveBeenCalledTimes(1);
    expect(h.startRun.mock.calls[0][0]).toMatchObject({
      workspaceId: "w1",
      userInput: "do the thing",
      origin: "scheduled",
    });

    // Run still in flight -> a second tick must be a no-op (reentrancy guard).
    scheduler._tick();
    expect(h.startRun).toHaveBeenCalledTimes(1);
  });

  it("records the outcome and advances nextRunAt when the run completes", () => {
    seed();
    scheduler._tick();
    h.subCb?.({ type: "token", content: "all done" });
    h.subCb?.({ type: "done" });

    const s = store.getSchedule("w1");
    expect(s?.lastRunStatus).toBe("ok");
    expect(s?.lastRunSnippet).toBe("all done");
    expect(new Date(s!.nextRunAt!).getTime()).toBeGreaterThan(Date.now());

    // In-flight cleared and nextRunAt now future -> next tick does not fire.
    scheduler._tick();
    expect(h.startRun).toHaveBeenCalledTimes(1);
  });

  it("marks the run as error when the run emits an error event", () => {
    seed();
    scheduler._tick();
    h.subCb?.({ type: "error", message: "boom" });
    h.subCb?.({ type: "done" });
    expect(store.getSchedule("w1")?.lastRunStatus).toBe("error");
    expect(store.getSchedule("w1")?.lastRunSnippet).toBe("boom");
  });

  it("does not fire a disabled schedule", () => {
    seed({ enabled: false });
    scheduler._tick();
    expect(h.startRun).not.toHaveBeenCalled();
  });

  it("does not fire a schedule whose next run is in the future", () => {
    seed({ nextRunAt: future });
    scheduler._tick();
    expect(h.startRun).not.toHaveBeenCalled();
  });
});
