// A due, enabled schedule fires one run through the broker, never re-fires while it is in flight, and
// on completion records the outcome and advances nextRunAt. Broker/agent/services deps are mocked.
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
  replay: [] as Array<{ type: "error"; message: string }>,
  subStatus: "running" as "running" | "done",
  alreadyRunning: false,
  workspaceLookups: 0,
  workspaceDisappears: false,
  capacityReached: false,
  messages: [] as Array<{ content?: unknown }>,
  persist: vi.fn(),
}));

vi.mock("../services", () => ({
  getStore: () => ({
    getWorkspace: (id: string) => {
      h.workspaceLookups += 1;
      return id === "w1" && (!h.workspaceDisappears || h.workspaceLookups === 1)
        ? { id: "w1", name: "WS", dir: "/tmp/w1", maxIterations: 10, maxRunMinutes: 5 }
        : undefined;
    },
  }),
}));
vi.mock("../../agent/runBroker", () => ({
  startRun: (p: unknown) => {
    h.startRun(p);
    return {
      alreadyRunning: h.alreadyRunning,
      ...(h.capacityReached ? { capacityReached: { active: 10, limit: 10, available: 0, atCapacity: true } } : {}),
    };
  },
  subscribe: (_w: string, _c: string, cb: (e: { type: string }) => void) => {
    h.subCb = cb;
    return { replay: h.replay, userInput: "", status: h.subStatus, unsubscribe: h.unsubscribe };
  },
}));
vi.mock("@/lib/conversations/store", () => ({
  createConversation: (workspaceId: string) => {
    h.createConversation(workspaceId);
    return { id: "conv-1" };
  },
  getMessages: () => h.messages,
  persist: h.persist,
}));
// These prompt mocks intercept the shared workspacePrompt helper one layer below the operation.
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
  h.replay = [];
  h.alreadyRunning = false;
  h.workspaceLookups = 0;
  h.workspaceDisappears = false;
  h.capacityReached = false;
  h.messages = [];
  h.persist.mockClear();
  clearSingletons();
  vi.resetModules();
  store = await import("./scheduleStore");
  scheduler = await import("./scheduler");
});

describe("scheduler tick", () => {
  it("fires a due enabled schedule exactly once and does not re-fire while in flight", () => {
    seed();
    scheduler._tick();
    expect(h.createConversation).toHaveBeenCalledWith("w1");
    expect(h.startRun).toHaveBeenCalledTimes(1);
    expect(h.startRun.mock.calls[0][0]).toMatchObject({
      workspaceId: "w1",
      userInput: "do the thing",
      maxRunMinutes: 5,
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
    expect(s?.lastRun).toEqual({ at: expect.any(String), status: "ok", conversationId: "conv-1" });
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
    expect(store.getSchedule("w1")?.lastRun).toMatchObject({
      status: "error",
      error: "boom",
      conversationId: "conv-1",
    });
  });

  it("records a capacity refusal and leaves the explanation in the scheduled conversation", () => {
    seed();
    h.capacityReached = true;

    scheduler._tick();

    const lastRun = store.getSchedule("w1")?.lastRun;
    expect(lastRun?.status).toBe("error");
    expect(lastRun?.error).toContain("Execution capacity reached: 10/10 agent runs are active");
    expect(lastRun?.conversationId).toBe("conv-1");
    expect(h.persist).toHaveBeenCalledWith("w1", "conv-1");
    expect(h.messages.at(-1)?.content).toContain("Execution capacity reached");
    expect(h.subCb).toBeNull();
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

  it("clears inflight and advances when the workspace disappears before the operation starts", () => {
    seed();
    h.workspaceDisappears = true;

    scheduler._tick();

    expect(h.startRun).not.toHaveBeenCalled();
    expect(new Date(store.getSchedule("w1")!.nextRunAt!).getTime()).toBeGreaterThan(Date.now());

    // Re-seed the due instant: a second fire proves the first skip removed the in-flight guard.
    h.workspaceDisappears = false;
    h.workspaceLookups = 0;
    seed();
    scheduler._tick();
    expect(h.startRun).toHaveBeenCalledOnce();
  });

  it("does not subscribe or record an outcome when the broker reports an in-flight run", () => {
    seed();
    h.alreadyRunning = true;

    scheduler._tick();

    expect(h.startRun).toHaveBeenCalledOnce();
    expect(h.subCb).toBeNull();
    expect(store.getSchedule("w1")?.lastRun).toBeUndefined();

    // A later due fire can proceed because the skip removed the scheduler's in-flight guard.
    h.alreadyRunning = false;
    seed();
    scheduler._tick();
    expect(h.startRun).toHaveBeenCalledTimes(2);
  });

  it("advances nextRunAt on an in-flight skip, so an unchanged past instant cannot re-fire every tick", () => {
    seed();
    h.alreadyRunning = true;

    scheduler._tick();

    expect(new Date(store.getSchedule("w1")!.nextRunAt!).getTime()).toBeGreaterThan(Date.now());

    // Without re-seeding: a second tick must not fire again, because nextRunAt is no longer due.
    scheduler._tick();
    expect(h.startRun).toHaveBeenCalledOnce();
  });
});

describe("dispatch boundaries", () => {
  it("does not dispatch a due occurrence after its end bound", () => {
    seed({ endAt: "2020-01-02T00:00" });
    scheduler._tick();
    expect(h.startRun).not.toHaveBeenCalled();
    expect(store.getSchedule("w1")?.nextRunAt).toBeNull();
  });

  it("records an error already buffered when subscribing", () => {
    seed();
    h.subStatus = "done";
    h.replay = [{ type: "error", message: "immediate failure" }];
    scheduler._tick();
    expect(store.getSchedule("w1")?.lastRun).toMatchObject({ status: "error", error: "immediate failure" });
  });
});

it("retries persistence without re-running the agent after a failed outcome write", () => {
  seed();
  scheduler._tick();
  const temporaryFile = path.join(ROOT, ".cron-schedules.json.tmp");
  fs.mkdirSync(temporaryFile);
  h.subCb?.({ type: "done" });
  scheduler._tick();
  expect(h.startRun).toHaveBeenCalledTimes(1);
  expect(store.getSchedule("w1")?.lastRun).toBeUndefined();
  fs.rmdirSync(temporaryFile);
  scheduler._tick();
  expect(store.getSchedule("w1")?.lastRun?.status).toBe("ok");
  scheduler._tick();
  expect(h.startRun).toHaveBeenCalledTimes(1);
});
