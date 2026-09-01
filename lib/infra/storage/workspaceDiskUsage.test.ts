// getWorkspaceDiskUsage sums the three durable locations a workspace occupies, so the test writes
// known files into a real temp root and checks each lands in the right bucket — a directory that was
// never created must count as 0, not fail the measurement.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { getWorkspaceDiskUsage } from "./workspaceDiskUsage";

let root: string;

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "ws-disk-"));
  const id = "ws-1";
  await mkdir(path.join(root, id), { recursive: true });
  await mkdir(path.join(root, ".homes", id), { recursive: true });
  await mkdir(path.join(root, ".versioning", id), { recursive: true });
  await writeFile(path.join(root, id, "tree.bin"), Buffer.alloc(500));
  await writeFile(path.join(root, ".homes", id, "dep.bin"), Buffer.alloc(4000));
  await writeFile(path.join(root, ".versioning", id, "snap.bin"), Buffer.alloc(1000));
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("getWorkspaceDiskUsage", () => {
  it("attributes each file to its bucket and totals them", async () => {
    const usage = await getWorkspaceDiskUsage("ws-1", root);
    expect(usage.breakdown).toEqual({ workspace: 500, home: 4000, versioning: 1000 });
    expect(usage.bytes).toBe(5500);
  });

  it("counts absent directories as 0 instead of failing", async () => {
    const usage = await getWorkspaceDiskUsage("never-created", root);
    expect(usage).toEqual({
      workspaceId: "never-created",
      bytes: 0,
      breakdown: { workspace: 0, home: 0, versioning: 0 },
    });
  });
});
