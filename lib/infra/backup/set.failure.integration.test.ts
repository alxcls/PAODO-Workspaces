// A backup that fails must be loud, never silent. Plant a file where the set directory's parent
// needs to be, so the first archive's mkdir fails, and assert archiveSet both rejects (the catch
// rethrows, never swallows) and emits the per-stage and set-level failure records operators grep for.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "os";
import path from "path";

const DEPLOYMENT = "test-deployment";

let written: Record<string, unknown>[];
let root: string;
let out: string;

beforeEach(() => {
  written = [];
  process.env.LOG_LEVEL = "info";
  const realWriteSync = fs.writeSync.bind(fs);
  vi.spyOn(fs, "writeSync").mockImplementation(((fd: number, data: unknown, ...rest: unknown[]) => {
    if (fd !== 1) return (realWriteSync as (...a: unknown[]) => number)(fd, data, ...rest);
    for (const line of String(data).split("\n").filter(Boolean))
      written.push(JSON.parse(line) as Record<string, unknown>);
    return String(data).length;
  }) as typeof fs.writeSync);
  root = fs.mkdtempSync(path.join(os.tmpdir(), "set-fail-"));
  out = path.join(root, "backups");
  fs.mkdirSync(out, { recursive: true });
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.PAODO_DEPLOYMENT;
  delete process.env.WORKSPACES_ROOT;
  fs.rmSync(root, { recursive: true, force: true });
});

describe("archiveSet failure logging", () => {
  it("rejects and logs both the stage and set-level failure when a build fails", async () => {
    fs.writeFileSync(path.join(out, DEPLOYMENT), "not a directory");
    process.env.WORKSPACES_ROOT = root;
    process.env.PAODO_DEPLOYMENT = DEPLOYMENT;
    vi.resetModules();
    const { archiveSet } = await import("./set");
    const { flushLogsSync } = await import("../logger");

    await expect(archiveSet(out, { rootDir: root, image: { ref: "x", hash: "y" }, workspaces: [] })).rejects.toThrow();
    flushLogsSync();

    const events = written.map((line) => line.event);
    expect(events).toContain("graph_archive_failed");
    expect(events).toContain("backup_set_build_failed");
    const setFailure = written.find((line) => line.event === "backup_set_build_failed");
    expect(setFailure).toMatchObject({ level: 50, context: "backup", outcome: "set_not_built", instance: DEPLOYMENT });
    expect(setFailure).toHaveProperty("err");
  });
});
