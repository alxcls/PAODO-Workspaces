// End-to-end against real tar in a temp root: a full set is graph + database + a workspace under
// <instance>/<stamp>-<id>/, defined by backup.json. Asserts the layout, the manifest's identity
// fields, the entry union, and that every recorded sha256 matches the file on disk.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createHash } from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import type { Workspace } from "../../workspace/types";

const DEPLOYMENT = "test-deployment";
const WS_ID = "ws-set-int";

function clearSingletons(): void {
  const g = global as typeof global & { __singletons?: Record<string, unknown> };
  if (g.__singletons) delete g.__singletons.workspaceGraph;
}

function makeWorkspace(dir: string): Workspace {
  return {
    id: WS_ID,
    name: "Set Agent",
    dir,
    createdAt: new Date("2026-01-02T03:04:05.000Z"),
    maxIterations: 25,
    maxRunMinutes: 30,
    internetAccess: false,
  };
}

function sha256(file: string): string {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

let root: string;
let out: string;

async function freshArchiveSet() {
  clearSingletons();
  process.env.WORKSPACES_ROOT = root;
  process.env.PAODO_DEPLOYMENT = DEPLOYMENT;
  vi.resetModules();
  return (await import("./set")).archiveSet;
}

describe("archiveSet (real tar)", () => {
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "set-archive-"));
    out = path.join(root, "backups");
    fs.writeFileSync(
      path.join(root, ".workspace-graph.json"),
      JSON.stringify({ edges: [{ id: "call_x", source: WS_ID, target: WS_ID }], positions: { [WS_ID]: { col: 0, row: 0 } } }),
    );
    const home = path.join(root, ".homes", WS_ID);
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(path.join(home, ".bashrc"), "export PATH=$PATH\n");
  });

  afterEach(() => {
    clearSingletons();
    delete process.env.PAODO_DEPLOYMENT;
    delete process.env.WORKSPACES_ROOT;
    fs.rmSync(root, { recursive: true, force: true });
  });

  async function run() {
    const archiveSet = await freshArchiveSet();
    return archiveSet(out, {
      rootDir: root,
      image: { ref: "test-image", hash: "testhash" },
      workspaces: [makeWorkspace(path.join(root, WS_ID))],
    });
  }

  it("groups the set under <instance>/<stamp>-<id> and writes backup.json", async () => {
    const { setDir, prefix, manifest } = await run();

    expect(prefix).toMatch(new RegExp(`^${DEPLOYMENT}/\\d{4}-\\d{2}-\\d{2}T[\\d-]+Z-[0-9a-f]{12}$`));
    expect(path.dirname(setDir)).toBe(path.join(out, DEPLOYMENT));
    expect(fs.existsSync(path.join(setDir, "backup.json"))).toBe(true);
    expect(manifest.kind).toBe("set");
    expect(manifest.schemaVersion).toBe(1);
  });

  it("names an opaque id and stores the instance so the key is reconstructable", async () => {
    const { setDir, manifest } = await run();
    const { archiveStamp } = await import("../archive/core");

    expect(manifest.id).toMatch(/^[0-9a-f]{12}$/);
    expect(manifest.instance).toBe(DEPLOYMENT);
    expect(manifest.source.deployment).toBe(DEPLOYMENT);
    const rebuilt = `${manifest.instance}/${archiveStamp(new Date(manifest.source.capturedAt))}-${manifest.id}`;
    expect(path.basename(path.dirname(setDir)) + "/" + path.basename(setDir)).toBe(rebuilt);
  });

  it("records every member as a typed entry with a matching sha256", async () => {
    const { setDir, manifest } = await run();

    const kinds = manifest.entries.map((e) => e.kind).sort();
    expect(kinds).toEqual(["database", "drives", "graph", "workspace"]);

    const ws = manifest.entries.find((e) => e.kind === "workspace");
    expect(ws).toMatchObject({ kind: "workspace", workspaceId: WS_ID });
    const graph = manifest.entries.find((e) => e.kind === "graph");
    expect(graph).not.toHaveProperty("workspaceId");

    for (const entry of manifest.entries) {
      const file = path.join(setDir, entry.file);
      expect(fs.existsSync(file)).toBe(true);
      expect(sha256(file)).toBe(entry.sha256);
    }
  });

  it("writes archives that verify against their own manifests", async () => {
    const { setDir, manifest } = await run();
    const { verifyArchive } = await import("../archive/core");

    for (const entry of manifest.entries) {
      expect((await verifyArchive(path.join(setDir, entry.file))).ok).toBe(true);
    }
  });

  it("refuses to run without a deployment name", async () => {
    const archiveSet = await freshArchiveSet();
    delete process.env.PAODO_DEPLOYMENT;
    await expect(
      archiveSet(out, { rootDir: root, image: { ref: "x", hash: "y" }, workspaces: [] }),
    ).rejects.toThrow(/PAODO_DEPLOYMENT/);
  });
});
