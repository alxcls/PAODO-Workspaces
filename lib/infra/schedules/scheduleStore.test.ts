// The JSON-backed, one-per-workspace registry: round-trips, recordRun's single outcome + pointer write,
// the legacy-record upgrade, and survival across a reload from disk (a fresh module instance).
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

  it("recordRun stores the outcome and advances the next-run pointer in one write", () => {
    store.setSchedule(entry(store));
    const run = { at: "2026-07-13T09:00:05.000Z", status: "ok" as const, conversationId: "conv-1" };
    store.recordRun("w1", run, "2026-07-14T09:00:00.000Z");
    expect(store.getSchedule("w1")).toMatchObject({ lastRun: run, nextRunAt: "2026-07-14T09:00:00.000Z" });
  });

  it("recordRun replaces the previous outcome whole, so a success drops an earlier error", () => {
    store.setSchedule(entry(store));
    store.recordRun("w1", { at: "2026-07-13T09:00:05.000Z", status: "error", error: "boom" }, null);
    store.recordRun("w1", { at: "2026-07-14T09:00:05.000Z", status: "ok", conversationId: "conv-2" }, null);
    expect(store.getSchedule("w1")?.lastRun).toEqual({
      at: "2026-07-14T09:00:05.000Z",
      status: "ok",
      conversationId: "conv-2",
    });
  });

  it("upgrades a record written with flat last-run fields, dropping the retired snippet", async () => {
    const legacy = {
      ...entry(store),
      lastRunAt: "2026-07-13T09:00:05.000Z",
      lastRunStatus: "error",
      lastRunSnippet: "boom",
    };
    fs.writeFileSync(FILE, JSON.stringify({ w1: legacy }));
    clearSingletons();
    vi.resetModules();
    const reloaded = await import("./scheduleStore");

    const s = reloaded.getSchedule("w1");
    expect(s?.lastRun).toEqual({ at: "2026-07-13T09:00:05.000Z", status: "error" });
    for (const retired of ["lastRunAt", "lastRunStatus", "lastRunSnippet"]) expect(s).not.toHaveProperty(retired);
  });

  it("leaves a never-run legacy record without a last run", async () => {
    fs.writeFileSync(FILE, JSON.stringify({ w1: entry(store) }));
    clearSingletons();
    vi.resetModules();
    const reloaded = await import("./scheduleStore");
    expect(reloaded.getSchedule("w1")).not.toHaveProperty("lastRun");
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

describe("failed persistence", () => {
  it("does not publish a failed configuration, pointer, outcome, or deletion", () => {
    store.setSchedule(entry(store));
    const before = store.getSchedule("w1");
    // A directory at the temporary filename reliably refuses writes on every platform.
    fs.mkdirSync(FILE + ".tmp");
    expect(() => store.setSchedule(entry(store, { prompt: "not saved" }))).toThrow();
    expect(store.getSchedule("w1")).toEqual(before);
    expect(() => store.setNextRunAt("w1", null)).toThrow();
    expect(store.getSchedule("w1")).toEqual(before);
    expect(() => store.recordRun("w1", { at: "2026-07-13T09:00Z", status: "error" }, null)).toThrow();
    expect(store.getSchedule("w1")).toEqual(before);
    expect(() => store.clearSchedule("w1")).toThrow();
    expect(store.getSchedule("w1")).toEqual(before);
    expect(JSON.parse(fs.readFileSync(FILE, "utf8"))["w1"]).toEqual(before);
  });
});
