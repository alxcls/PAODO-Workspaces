// End-to-end against real tar: archive drives from one root, apply onto another, and prove the target
// is made to match the archive — replaced when it holds drives, cleared when it holds none.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

const DEPLOYMENT = "test-deployment";

let src: string;
let dst: string;
let out: string;

async function freshModules() {
  process.env.PAODO_DEPLOYMENT = DEPLOYMENT;
  vi.resetModules();
  return {
    archiveDrives: (await import("./archive")).archiveDrives,
    applyDrivesArchive: (await import("./apply")).applyDrivesArchive,
  };
}

function seedDrives(root: string, id: string, file: { name: string; body: string }): void {
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, ".drives.json"), JSON.stringify([{ id, name: id, createdAt: "2026-01-01T00:00:00.000Z" }]));
  fs.writeFileSync(path.join(root, ".drive-connections.json"), JSON.stringify([{ id: `link_${id}`, driveId: id, workspaceId: "ws-a" }]));
  const contentDir = path.join(root, ".drives", id);
  fs.mkdirSync(contentDir, { recursive: true });
  fs.writeFileSync(path.join(contentDir, file.name), file.body);
}

describe("applyDrivesArchive (real tar)", () => {
  beforeEach(() => {
    src = fs.mkdtempSync(path.join(os.tmpdir(), "drives-apply-src-"));
    dst = fs.mkdtempSync(path.join(os.tmpdir(), "drives-apply-dst-"));
    out = fs.mkdtempSync(path.join(os.tmpdir(), "drives-apply-out-"));
  });

  afterEach(() => {
    delete process.env.PAODO_DEPLOYMENT;
    for (const dir of [src, dst, out]) fs.rmSync(dir, { recursive: true, force: true });
  });

  it("replaces live drives with the archived ones", async () => {
    const { archiveDrives, applyDrivesArchive } = await freshModules();
    seedDrives(src, "drive-A", { name: "a.txt", body: "from A\n" });
    const { path: archive } = await archiveDrives(out, { rootDir: src });

    seedDrives(dst, "drive-B", { name: "b.txt", body: "from B\n" });
    await applyDrivesArchive(archive, { rootDir: dst, force: true });

    const drives = JSON.parse(fs.readFileSync(path.join(dst, ".drives.json"), "utf-8"));
    expect(drives).toEqual([{ id: "drive-A", name: "drive-A", createdAt: "2026-01-01T00:00:00.000Z" }]);
    expect(fs.existsSync(path.join(dst, ".drives", "drive-B"))).toBe(false);
    expect(fs.readFileSync(path.join(dst, ".drives", "drive-A", "a.txt"), "utf-8")).toBe("from A\n");
  });

  it("clears live drives when the archive was captured with none", async () => {
    const { archiveDrives, applyDrivesArchive } = await freshModules();
    const { path: archive } = await archiveDrives(out, { rootDir: src });

    seedDrives(dst, "drive-B", { name: "b.txt", body: "from B\n" });
    await applyDrivesArchive(archive, { rootDir: dst, force: true });

    expect(JSON.parse(fs.readFileSync(path.join(dst, ".drives.json"), "utf-8"))).toEqual([]);
    expect(JSON.parse(fs.readFileSync(path.join(dst, ".drive-connections.json"), "utf-8"))).toEqual([]);
    expect(fs.readdirSync(path.join(dst, ".drives"))).toEqual([]);
  });

  it("refuses to overwrite live drives without force", async () => {
    const { archiveDrives, applyDrivesArchive } = await freshModules();
    seedDrives(src, "drive-A", { name: "a.txt", body: "from A\n" });
    const { path: archive } = await archiveDrives(out, { rootDir: src });

    seedDrives(dst, "drive-B", { name: "b.txt", body: "from B\n" });
    await expect(applyDrivesArchive(archive, { rootDir: dst })).rejects.toThrow(/without force/);
    expect(fs.existsSync(path.join(dst, ".drives", "drive-B"))).toBe(true);
  });
});
