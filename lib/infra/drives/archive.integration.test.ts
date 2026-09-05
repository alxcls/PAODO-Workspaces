// End-to-end against real tar in a temp root. Drives carry two JSON siblings plus a nested content
// tar, so the cases that matter are the round-trip of all three and the fresh-instance absence.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";

const DEPLOYMENT = "test-deployment";

const DRIVES = [{ id: "drive-1", name: "Shared", createdAt: "2026-01-01T00:00:00.000Z" }];
const CONNECTIONS = [{ id: "link_1", driveId: "drive-1", workspaceId: "ws-a" }];
const CONTENT = "hello from a drive\n";

let root: string;
let out: string;

/** Re-imports under a fresh WORKSPACES_ROOT so the archiver reads the seeded files. */
async function freshModules() {
  process.env.WORKSPACES_ROOT = root;
  process.env.PAODO_DEPLOYMENT = DEPLOYMENT;
  vi.resetModules();
  return import("./archive");
}

function listMembers(archive: string): string[] {
  return execFileSync("tar", ["-tf", archive], { encoding: "utf-8" }).trim().split("\n");
}

function extract(archive: string, member: string): string {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "drives-archive-out-"));
  execFileSync("tar", ["-xf", archive, "-C", scratch, member]);
  return path.join(scratch, member);
}

describe("archiveDrives (real tar)", () => {
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "drives-archive-"));
    out = path.join(root, "backups");
    fs.writeFileSync(path.join(root, ".drives.json"), JSON.stringify(DRIVES));
    fs.writeFileSync(path.join(root, ".drive-connections.json"), JSON.stringify(CONNECTIONS));
    fs.mkdirSync(path.join(root, ".drives", "drive-1"), { recursive: true });
    fs.writeFileSync(path.join(root, ".drives", "drive-1", "hello.txt"), CONTENT);
  });

  afterEach(() => {
    delete process.env.PAODO_DEPLOYMENT;
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("writes the manifest first, then registry, connections and content", async () => {
    const { archiveDrives } = await freshModules();
    const result = await archiveDrives(out);

    expect(listMembers(result.path)).toEqual([
      "manifest.json",
      "drives.json",
      "drive-connections.json",
      "drives-content.tar.gz",
    ]);
    expect(result.manifest.kind).toBe("drives");
    expect(result.manifest.source.deployment).toBe(DEPLOYMENT);
  });

  it("captures registry, connections and file content exactly", async () => {
    const { archiveDrives } = await freshModules();
    const result = await archiveDrives(out);

    expect(JSON.parse(fs.readFileSync(extract(result.path, "drives.json"), "utf-8"))).toEqual(DRIVES);
    expect(JSON.parse(fs.readFileSync(extract(result.path, "drive-connections.json"), "utf-8"))).toEqual(CONNECTIONS);

    const nested = extract(result.path, "drives-content.tar.gz");
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "drives-content-out-"));
    execFileSync("tar", ["-xzf", nested, "-C", scratch]);
    expect(fs.readFileSync(path.join(scratch, "drive-1", "hello.txt"), "utf-8")).toBe(CONTENT);
  });

  it("still emits every member as empty when the instance has no drives", async () => {
    fs.rmSync(path.join(root, ".drives.json"));
    fs.rmSync(path.join(root, ".drive-connections.json"));
    fs.rmSync(path.join(root, ".drives"), { recursive: true, force: true });
    const { archiveDrives } = await freshModules();
    const { verifyArchive } = await import("../archive/core");

    const result = await archiveDrives(out);
    expect(listMembers(result.path)).toEqual([
      "manifest.json",
      "drives.json",
      "drive-connections.json",
      "drives-content.tar.gz",
    ]);
    expect(JSON.parse(fs.readFileSync(extract(result.path, "drives.json"), "utf-8"))).toEqual([]);
    expect((await verifyArchive(result.path)).ok).toBe(true);
  });

  it("verifies a good archive and rejects a tampered one", async () => {
    const { archiveDrives } = await freshModules();
    const { verifyArchive } = await import("../archive/core");
    const result = await archiveDrives(out);
    expect((await verifyArchive(result.path)).ok).toBe(true);

    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "drives-archive-tamper-"));
    execFileSync("tar", ["-xzf", result.path, "-C", scratch]);
    fs.appendFileSync(path.join(scratch, "drives.json"), " ");
    const corrupted = path.join(root, "corrupted.tar.gz");
    execFileSync("tar", ["-czf", corrupted, "-C", scratch, ...listMembers(result.path)]);

    const checked = await verifyArchive(corrupted);
    expect(checked.ok).toBe(false);
    expect(checked.problems.join(" ")).toMatch(/drives\.json/);
  });

  it("never overwrites an existing archive", async () => {
    const { archiveDrives } = await freshModules();
    const first = await archiveDrives(out);
    await expect(archiveDrives(first.path)).rejects.toThrow(/Refusing to overwrite/);
  });

  it("refuses to write an archive that does not name its deployment", async () => {
    const { archiveDrives } = await freshModules();
    delete process.env.PAODO_DEPLOYMENT;
    await expect(archiveDrives(out)).rejects.toThrow(/PAODO_DEPLOYMENT/);
  });
});
