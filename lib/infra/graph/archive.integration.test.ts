// End-to-end against real tar in a temp root. The graph is a single JSON document, so the case that
// matters is the round-trip: what getGraph() holds must land in graph.json byte-for-byte and verify.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";

const DEPLOYMENT = "test-deployment";

const GRAPH = {
  edges: [{ id: "call_abc", source: "ws-a", target: "ws-b" }],
  positions: { "ws-a": { col: 0, row: 0 }, "ws-b": { col: 1, row: 0 } },
};

function clearGraphSingleton(): void {
  const g = global as typeof global & { __singletons?: Record<string, unknown> };
  if (g.__singletons) delete g.__singletons.workspaceGraph;
}

let root: string;
let out: string;

/** Re-imports under a fresh WORKSPACES_ROOT so getGraph reads the seeded file at module load. */
async function freshModules() {
  clearGraphSingleton();
  process.env.WORKSPACES_ROOT = root;
  process.env.PAODO_DEPLOYMENT = DEPLOYMENT;
  vi.resetModules();
  return import("./archive");
}

function listMembers(archive: string): string[] {
  return execFileSync("tar", ["-tf", archive], { encoding: "utf-8" }).trim().split("\n");
}

function extract(archive: string, member: string): string {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "graph-archive-out-"));
  execFileSync("tar", ["-xf", archive, "-C", scratch, member]);
  return path.join(scratch, member);
}

describe("archiveGraph (real tar)", () => {
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "graph-archive-"));
    out = path.join(root, "backups");
    fs.writeFileSync(path.join(root, ".workspace-graph.json"), JSON.stringify(GRAPH));
  });

  afterEach(() => {
    clearGraphSingleton();
    delete process.env.PAODO_DEPLOYMENT;
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("writes the manifest first, then the graph", async () => {
    const { archiveGraph } = await freshModules();
    const result = await archiveGraph(out);

    expect(listMembers(result.path)).toEqual(["manifest.json", "graph.json"]);
    expect(result.manifest.kind).toBe("graph");
    expect(result.manifest.source.deployment).toBe(DEPLOYMENT);
  });

  it("captures the graph exactly as stored", async () => {
    const { archiveGraph } = await freshModules();
    const result = await archiveGraph(out);

    const captured = JSON.parse(fs.readFileSync(extract(result.path, "graph.json"), "utf-8"));
    expect(captured).toEqual(GRAPH);
  });

  it("archives an instance that has no graph yet", async () => {
    fs.rmSync(path.join(root, ".workspace-graph.json"));
    const { archiveGraph } = await freshModules();
    const { verifyArchive } = await import("../archive/core");

    const result = await archiveGraph(out);
    const captured = JSON.parse(fs.readFileSync(extract(result.path, "graph.json"), "utf-8"));
    expect(captured).toEqual({ edges: [], positions: {} });
    expect((await verifyArchive(result.path)).ok).toBe(true);
  });

  it("verifies a good archive and rejects a tampered one", async () => {
    const { archiveGraph } = await freshModules();
    const { verifyArchive } = await import("../archive/core");
    const result = await archiveGraph(out);
    expect((await verifyArchive(result.path)).ok).toBe(true);

    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "graph-archive-tamper-"));
    execFileSync("tar", ["-xf", result.path, "-C", scratch]);
    fs.appendFileSync(path.join(scratch, "graph.json"), "\n");
    const corrupted = path.join(root, "corrupted.tar");
    execFileSync("tar", ["-cf", corrupted, "-C", scratch, ...listMembers(result.path)]);

    const checked = await verifyArchive(corrupted);
    expect(checked.ok).toBe(false);
    expect(checked.problems.join(" ")).toMatch(/graph\.json/);
  });

  it("never overwrites an existing archive", async () => {
    const { archiveGraph } = await freshModules();
    const first = await archiveGraph(out);
    await expect(archiveGraph(first.path)).rejects.toThrow(/Refusing to overwrite/);
  });

  it("refuses to write an archive that does not name its deployment", async () => {
    const { archiveGraph } = await freshModules();
    delete process.env.PAODO_DEPLOYMENT;
    await expect(archiveGraph(out)).rejects.toThrow(/PAODO_DEPLOYMENT/);
  });
});
