// The schedule store is a JSON-backed, one-per-workspace registry. What matters: read/write round-trips,
// recordRun updates the run-status fields + next-run pointer atomically, and everything survives a
// reload from disk (a fresh module instance reads the persisted file).
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "schedulestore-test-"));
const FILE = path.join(ROOT, ".cron-schedules.json");

afterAll(() => fs.rmSync(ROOT, { recursive: true, force: true }));

// The in-memory store is cached on global.__singletons (survives Next.js hot-reloads and
// vi.resetModules), so clear it explicitly to isolate each test.
function clearSingletons() {
  delete (global as Record<string, unknown>).__singletons;
}

async function freshStore() {
  fs.rmSync(ROOT, { recursive: true, force: true });
  fs.mkdirSync(ROOT, { recursive: true });
  process.env.WORKSPACES_ROOT = ROOT;
  clearSingletons();
  vi.resetModules();
  return import("./scheduleStore");
}

type Store = typeof import("./scheduleStore");

function entry(store: Store, over: Partial<Parameters<Store["setSchedule"]>[0]> = {}) {
  return {
    id: "s1",
    workspaceId: "w1",
    prompt: "run",
    intervalValue: 1,
    intervalUnit: "day" as const,
    startAt: "2026-07-13T09:00",
    timezone: "UTC",
    enabled: true,
    createdAt: "2026-07-12T00:00:00.000Z",
    nextRunAt: "2026-07-13T09:00:00.000Z",
    ...over,
  };
}

let store: Store;
beforeEach(async () => {
  store = await freshStore();
});

describe("scheduleStore", () => {
  it("returns null before anything is set", () => {
    expect(store.getSchedule("w1")).toBeNull();
    expect(store.listAll()).toEqual([]);
  });

  it("sets, gets, and lists a schedule", () => {
    const e = entry(store);
    store.setSchedule(e);
    expect(store.getSchedule("w1")).toEqual(e);
    expect(store.listAll()).toEqual([e]);
  });

  it("keeps one schedule per workspace (set replaces)", () => {
    store.setSchedule(entry(store, { prompt: "first" }));
    store.setSchedule(entry(store, { prompt: "second" }));
    expect(store.getSchedule("w1")?.prompt).toBe("second");
    expect(store.listAll()).toHaveLength(1);
  });

  it("recordRun updates status, snippet, timestamps and next-run atomically", () => {
    store.setSchedule(entry(store));
    store.recordRun("w1", {
      at: "2026-07-13T09:00:05.000Z",
      status: "ok",
      snippet: "done",
      nextRunAt: "2026-07-14T09:00:00.000Z",
    });
    const s = store.getSchedule("w1");
    expect(s?.lastRunStatus).toBe("ok");
    expect(s?.lastRunSnippet).toBe("done");
    expect(s?.lastRunAt).toBe("2026-07-13T09:00:05.000Z");
    expect(s?.nextRunAt).toBe("2026-07-14T09:00:00.000Z");
  });

  it("setNextRunAt advances the pointer", () => {
    store.setSchedule(entry(store));
    store.setNextRunAt("w1", "2026-07-20T09:00:00.000Z");
    expect(store.getSchedule("w1")?.nextRunAt).toBe("2026-07-20T09:00:00.000Z");
  });

  it("clearSchedule removes the entry", () => {
    store.setSchedule(entry(store));
    store.clearSchedule("w1");
    expect(store.getSchedule("w1")).toBeNull();
    expect(store.listAll()).toEqual([]);
  });

  it("clearSchedule leaves other workspaces' schedules untouched", () => {
    store.setSchedule(entry(store, { workspaceId: "w1" }));
    store.setSchedule(entry(store, { workspaceId: "w2", id: "s2" }));
    store.clearSchedule("w1");
    expect(store.getSchedule("w1")).toBeNull();
    expect(store.getSchedule("w2")?.id).toBe("s2");
  });

  it("clearSchedule is a no-op when the workspace has no schedule", () => {
    store.setSchedule(entry(store));
    const before = fs.readFileSync(FILE, "utf8");
    const mtimeBefore = fs.statSync(FILE).mtimeMs;

    expect(() => store.clearSchedule("never-scheduled")).not.toThrow();

    // Guard-when-absent means no disk write at all, not just an unchanged result.
    expect(fs.readFileSync(FILE, "utf8")).toBe(before);
    expect(fs.statSync(FILE).mtimeMs).toBe(mtimeBefore);
    expect(store.getSchedule("w1")).not.toBeNull();
  });

  it("clearSchedule with no file on disk does not throw", () => {
    expect(fs.existsSync(FILE)).toBe(false);
    expect(() => store.clearSchedule("w1")).not.toThrow();
    expect(fs.existsSync(FILE)).toBe(false);
  });

  it("removal persists to disk and survives a reload", async () => {
    store.setSchedule(entry(store));
    store.clearSchedule("w1");

    // Reload without wiping the temp dir — the deletion must be on disk, not just in memory.
    process.env.WORKSPACES_ROOT = ROOT;
    clearSingletons();
    vi.resetModules();
    const reloaded = await import("./scheduleStore");
    expect(reloaded.getSchedule("w1")).toBeNull();
    expect(reloaded.listAll()).toEqual([]);
  });

  it("persists to disk and reloads in a fresh module instance", async () => {
    store.setSchedule(entry(store, { prompt: "persist me" }));
    expect(fs.existsSync(FILE)).toBe(true);

    // Reload without wiping the temp dir — a new module instance must read the file back.
    process.env.WORKSPACES_ROOT = ROOT;
    clearSingletons();
    vi.resetModules();
    const reloaded = await import("./scheduleStore");
    expect(reloaded.getSchedule("w1")?.prompt).toBe("persist me");
  });
});
