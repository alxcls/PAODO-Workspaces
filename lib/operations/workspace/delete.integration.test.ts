// Exercises the workspace deletion operation's cascade against real stores and a temp
// WORKSPACES_ROOT. Guards the invariant that a workspace-owned resource must not outlive its
// workspace. Schedules regressed this once: scheduleStore had no removal function at all, so
// deleting a workspace left its schedule (and the prompt it fires) behind forever.
import { describe, it, expect, vi, afterAll } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "workspace-cascade-test-"));
const SCHEDULES_FILE = path.join(ROOT, ".cron-schedules.json");

const h = vi.hoisted(() => ({
  store: null as null | { getWorkspace(id: string): unknown; deleteWorkspace(id: string): Promise<boolean> },
}));

vi.mock("@/lib/infra/services", () => ({
  getStore: () => h.store,
  getContainers: () => ({ remove: async () => {}, deleteWorkspaceDir: async () => {} }),
  getVersioning: () => ({ deleteRepo: async () => {} }),
}));

// Read at module-eval time by infra/paths.ts, so it must be set before the imports below.
process.env.WORKSPACES_ROOT = ROOT;

afterAll(() => fs.rmSync(ROOT, { recursive: true, force: true }));

async function freshModules() {
  // The stores cache on global.__singletons, surviving vi.resetModules — clear both.
  delete (global as Record<string, unknown>).__singletons;
  vi.resetModules();
  process.env.WORKSPACES_ROOT = ROOT;
  const workspaces = await import("../../infra/workspace/registry");
  h.store = workspaces.defaultWorkspaceStore;
  return {
    workspaces,
    schedules: await import("../../infra/schedules/scheduleStore"),
    operations: await import("./delete"),
    deletion: await import("../../infra/workspaceDeleteDeps"),
  };
}

function scheduleFor(workspaceId: string, prompt: string) {
  return {
    id: `sched-${workspaceId}`,
    workspaceId,
    prompt,
    intervalValue: 1,
    intervalUnit: "day" as const,
    startAt: "2026-07-13T09:00",
    timezone: "UTC",
    enabled: true,
    createdAt: "2026-07-12T00:00:00.000Z",
    nextRunAt: "2026-07-13T09:00:00.000Z",
  };
}

describe("workspace deletion cascade", () => {
  it("clears the deleted workspace's schedule, on disk as well as in memory", async () => {
    const { workspaces, schedules, operations, deletion } = await freshModules();
    const ws = await workspaces.defaultWorkspaceStore.createWorkspace("scheduled-ws");

    const prompt = "prompt that must not outlive the workspace";
    schedules.setSchedule(scheduleFor(ws.id, prompt));
    expect(schedules.getSchedule(ws.id)).not.toBeNull();

    await operations.deleteWorkspace(ws.id, deletion.workspaceDeleteDeps());

    expect(schedules.getSchedule(ws.id)).toBeNull();
    const onDisk = fs.existsSync(SCHEDULES_FILE) ? fs.readFileSync(SCHEDULES_FILE, "utf8") : "{}";
    expect(onDisk).not.toContain(ws.id);
    expect(onDisk).not.toContain(prompt);
  });

  it("leaves other workspaces' schedules intact", async () => {
    const { workspaces, schedules, operations, deletion } = await freshModules();
    const doomed = await workspaces.defaultWorkspaceStore.createWorkspace("doomed-ws");
    const survivor = await workspaces.defaultWorkspaceStore.createWorkspace("survivor-ws");

    schedules.setSchedule(scheduleFor(doomed.id, "goes away"));
    schedules.setSchedule(scheduleFor(survivor.id, "stays put"));

    await operations.deleteWorkspace(doomed.id, deletion.workspaceDeleteDeps());

    expect(schedules.getSchedule(doomed.id)).toBeNull();
    expect(schedules.getSchedule(survivor.id)?.prompt).toBe("stays put");
  });

  it("removes the agent's home and its seed receipt together", async () => {
    const { workspaces, operations, deletion } = await freshModules();
    const paths = await import("../../infra/paths");
    const ws = await workspaces.defaultWorkspaceStore.createWorkspace("homed-ws");
    fs.mkdirSync(path.join(paths.workspaceHomeDir(ws.id), ".nvm"), { recursive: true });
    fs.writeFileSync(paths.workspaceHomeSeededMarker(ws.id), "");

    await operations.deleteWorkspace(ws.id, deletion.workspaceDeleteDeps());

    // A receipt outliving its home is the dangerous half: it tells the next seed that a now-empty
    // home is already filled, booting a container with no node and no python.
    expect(fs.existsSync(paths.workspaceHomeSeededMarker(ws.id))).toBe(false);
    expect(fs.existsSync(paths.workspaceHomeDir(ws.id))).toBe(false);
  });

  it("deletes a workspace that never had a schedule without error", async () => {
    const { workspaces, schedules, operations, deletion } = await freshModules();
    const ws = await workspaces.defaultWorkspaceStore.createWorkspace("unscheduled-ws");

    await expect(operations.deleteWorkspace(ws.id, deletion.workspaceDeleteDeps())).resolves.toEqual({
      deleted: true,
    });
    expect(schedules.getSchedule(ws.id)).toBeNull();
  });
});
