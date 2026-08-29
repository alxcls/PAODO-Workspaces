// End-to-end against a real set on disk: archiveSet writes it, a fake ObjectSource serves it from the
// set dir, and verifySet pulls it into a temp workDir. Asserts a clean set verifies, and that the
// three ways a set goes wrong each surface as a problem rather than a crash: no marker, a member
// whose bytes drift from backup.json, and a member missing from the bucket.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import type { ObjectSource } from "./s3Source";
import type { Workspace } from "../../workspace/types";
import { SET_MANIFEST_MEMBER } from "../../archive/setManifest";

const DEPLOYMENT = "test-deployment";
const WS_ID = "ws-verify-int";

function clearSingletons(): void {
  const g = global as typeof global & { __singletons?: Record<string, unknown> };
  if (g.__singletons) delete g.__singletons.workspaceGraph;
}

function makeWorkspace(dir: string): Workspace {
  return {
    id: WS_ID,
    name: "Verify Agent",
    dir,
    createdAt: new Date("2026-01-02T03:04:05.000Z"),
    maxIterations: 25,
    maxRunMinutes: 30,
    internetAccess: false,
  };
}

let root: string;
let work: string;

async function freshArchiveSet() {
  clearSingletons();
  process.env.WORKSPACES_ROOT = root;
  process.env.PAODO_DEPLOYMENT = DEPLOYMENT;
  vi.resetModules();
  return (await import("./set")).archiveSet;
}

interface Faults {
  missingMarker?: boolean;
  drop?: Set<string>;
  corrupt?: Set<string>;
}

function fakeSource(setDir: string, prefix: string, faults: Faults = {}): ObjectSource {
  const toLocal = (key: string) => path.join(setDir, key.slice(prefix.length + 1));
  return {
    listSets: async () => [prefix],
    exists: async (key) => {
      if (faults.missingMarker && key.endsWith(SET_MANIFEST_MEMBER)) return false;
      return fs.existsSync(toLocal(key));
    },
    getText: async (key) => fs.readFileSync(toLocal(key), "utf8"),
    pull: async (key, localPath) => {
      const file = key.slice(prefix.length + 1);
      if (faults.drop?.has(file)) throw new Error("NoSuchKey");
      fs.copyFileSync(toLocal(key), localPath);
      if (faults.corrupt?.has(file)) fs.appendFileSync(localPath, "corruption");
    },
  };
}

describe("verifySet (real set on disk)", () => {
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "verify-set-"));
    work = fs.mkdtempSync(path.join(os.tmpdir(), "verify-work-"));
    fs.writeFileSync(
      path.join(root, ".workspace-graph.json"),
      JSON.stringify({
        edges: [{ id: "call_x", source: WS_ID, target: WS_ID }],
        positions: { [WS_ID]: { col: 0, row: 0 } },
      }),
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
    fs.rmSync(work, { recursive: true, force: true });
  });

  async function buildSet() {
    const archiveSet = await freshArchiveSet();
    const out = path.join(root, "backups");
    return archiveSet(out, {
      rootDir: root,
      image: { ref: "test-image", hash: "testhash" },
      workspaces: [makeWorkspace(path.join(root, WS_ID))],
    });
  }

  it("passes a clean set: every member matches backup.json", async () => {
    const { setDir, prefix } = await buildSet();
    const { verifySet } = await import("./setTransfer");

    const result = await verifySet(prefix, work, fakeSource(setDir, prefix));

    expect(result.problems).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.manifest?.entries).toHaveLength(3);
  });

  it("fails a set with no commit marker without reading members", async () => {
    const { setDir, prefix } = await buildSet();
    const { verifySet } = await import("./setTransfer");

    const result = await verifySet(prefix, work, fakeSource(setDir, prefix, { missingMarker: true }));

    expect(result.ok).toBe(false);
    expect(result.problems).toEqual([expect.stringContaining("incomplete or does not exist")]);
    expect(result.manifest).toBeUndefined();
  });

  it("flags a member whose bytes drifted from backup.json", async () => {
    const { setDir, prefix, manifest } = await buildSet();
    const { verifySet } = await import("./setTransfer");
    const graph = manifest.entries.find((e) => e.kind === "graph")!.file;

    const result = await verifySet(prefix, work, fakeSource(setDir, prefix, { corrupt: new Set([graph]) }));

    expect(result.ok).toBe(false);
    expect(result.problems).toEqual([`${graph}: sha256 does not match ${SET_MANIFEST_MEMBER}`]);
  });

  it("flags a member missing from the bucket rather than crashing", async () => {
    const { setDir, prefix, manifest } = await buildSet();
    const { verifySet } = await import("./setTransfer");
    const db = manifest.entries.find((e) => e.kind === "database")!.file;

    const result = await verifySet(prefix, work, fakeSource(setDir, prefix, { drop: new Set([db]) }));

    expect(result.ok).toBe(false);
    expect(result.problems).toEqual([`${db}: NoSuchKey`]);
  });
});
