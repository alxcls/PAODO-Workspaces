/**
 * Folder transfers: drive_upload and drive_download of a directory copy every file under it, one at a
 * time, preserving structure — the same per-file path a single file takes, looped. These pin that the
 * whole tree travels, that the shared ignore contract still keeps node_modules/.git out, and that one
 * bad file is skipped rather than aborting the rest. Download writes host-side, like upload.
 */
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { MAX_DRIVE_TRANSFER_BYTES } from "@/lib/infra/limits";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "drivefolder-test-"));
afterAll(() => fs.rmSync(ROOT, { recursive: true, force: true }));

async function freshModules() {
  fs.rmSync(ROOT, { recursive: true, force: true });
  fs.mkdirSync(ROOT, { recursive: true });
  process.env.WORKSPACES_ROOT = ROOT;
  vi.resetModules();
  const store = await import("@/lib/drives/store");
  const { DriveDownloadTool } = await import("./driveDownload");
  const { DriveUploadTool } = await import("./driveUpload");
  return { store, DriveDownloadTool, DriveUploadTool };
}

type Mods = Awaited<ReturnType<typeof freshModules>>;
let mods: Mods;

beforeEach(async () => {
  mods = await freshModules();
});

function seedDrive(name: string): string {
  const drive = mods.store.createDrive(name);
  mods.store.connectDrive(drive.id, "ws1");
  return mods.store.driveContentDir(drive.id);
}

// The download tool writes host-side, so its workspace dir must exist before the containment check
// realpaths it. Returns the created dir.
function seedWorkspace(): string {
  const workspaceDir = path.join(ROOT, "ws1-files");
  fs.mkdirSync(workspaceDir, { recursive: true });
  return workspaceDir;
}

function write(root: string, rel: string, bytes: Buffer | string): void {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, bytes);
}

function sparseFile(absPath: string, size: number): void {
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  fs.closeSync(fs.openSync(absPath, "w"));
  fs.truncateSync(absPath, size);
}

describe("drive_upload folder", () => {
  it("uploads a whole folder recursively, preserving structure, under the folder name by default", async () => {
    const dir = seedDrive("data");
    const workspaceDir = seedWorkspace();
    write(workspaceDir, "proj/a.json", '{"a":1}');
    write(workspaceDir, "proj/sub/b.json", '{"b":2}');

    const result = await new mods.DriveUploadTool("ws1", workspaceDir).invoke({ source_path: "proj", drive_name: "data" });

    expect(result).toContain("Uploaded 2 files");
    expect(fs.readFileSync(path.join(dir, "proj/a.json"), "utf-8")).toBe('{"a":1}');
    expect(fs.readFileSync(path.join(dir, "proj/sub/b.json"), "utf-8")).toBe('{"b":2}');
  });

  it("lands the folder's contents under an explicit dest_path", async () => {
    const dir = seedDrive("data");
    const workspaceDir = seedWorkspace();
    write(workspaceDir, "proj/a.json", "x");

    await new mods.DriveUploadTool("ws1", workspaceDir).invoke({
      source_path: "proj",
      drive_name: "data",
      dest_path: "inbox/run1",
    });

    expect(fs.existsSync(path.join(dir, "inbox/run1/a.json"))).toBe(true);
  });

  it("leaves node_modules out of the transfer, as every other file surface does", async () => {
    const dir = seedDrive("data");
    const workspaceDir = seedWorkspace();
    write(workspaceDir, "proj/keep.json", "1");
    write(workspaceDir, "proj/node_modules/dep/index.js", "junk");

    const result = await new mods.DriveUploadTool("ws1", workspaceDir).invoke({ source_path: "proj", drive_name: "data" });

    expect(result).toContain("Uploaded 1 file ");
    expect(fs.existsSync(path.join(dir, "proj/node_modules"))).toBe(false);
  });

  it("errors on a folder with nothing to upload", async () => {
    seedDrive("data");
    const workspaceDir = seedWorkspace();
    fs.mkdirSync(path.join(workspaceDir, "empty"), { recursive: true });

    const result = await new mods.DriveUploadTool("ws1", workspaceDir).invoke({ source_path: "empty", drive_name: "data" });

    expect(result).toMatch(/holds no files to upload/);
  });
});

describe("drive_download folder", () => {
  it("downloads a whole folder recursively into downloads/<drive>/<path>, bytes intact", async () => {
    const dir = seedDrive("data");
    const original = Buffer.from([0x00, 0xff, 0x41]);
    write(dir, "docs/a.json", "hello");
    write(dir, "docs/sub/b.bin", original);
    const workspaceDir = seedWorkspace();

    const result = await new mods.DriveDownloadTool("ws1", workspaceDir).invoke({ drive_name: "data", path: "docs" });

    expect(fs.readFileSync(path.join(workspaceDir, "downloads/data/docs/a.json"), "utf-8")).toBe("hello");
    expect(fs.readFileSync(path.join(workspaceDir, "downloads/data/docs/sub/b.bin")).equals(original)).toBe(true);
    expect(result).toContain("Downloaded 2 files to downloads/data/docs");
  });

  it("skips a file over the ceiling and keeps going, reporting what it skipped", async () => {
    const dir = seedDrive("data");
    write(dir, "docs/small.json", "ok");
    sparseFile(path.join(dir, "docs", "big.bin"), MAX_DRIVE_TRANSFER_BYTES + 1);
    const workspaceDir = seedWorkspace();

    const result = await new mods.DriveDownloadTool("ws1", workspaceDir).invoke({ drive_name: "data", path: "docs" });

    expect(fs.existsSync(path.join(workspaceDir, "downloads/data/docs/small.json"))).toBe(true);
    expect(fs.existsSync(path.join(workspaceDir, "downloads/data/docs/big.bin"))).toBe(false);
    expect(result).toContain("Downloaded 1 file to downloads/data/docs");
    expect(result).toContain("Skipped 1: big.bin");
  });

  it("leads with an error when every file in the folder failed, not a '0 files' success", async () => {
    const dir = seedDrive("data");
    sparseFile(path.join(dir, "docs", "big1.bin"), MAX_DRIVE_TRANSFER_BYTES + 1);
    sparseFile(path.join(dir, "docs", "big2.bin"), MAX_DRIVE_TRANSFER_BYTES + 1);
    const workspaceDir = seedWorkspace();

    const result = await new mods.DriveDownloadTool("ws1", workspaceDir).invoke({ drive_name: "data", path: "docs" });

    expect(result).toMatch(/^Error:/);
    expect(result).not.toMatch(/^Downloaded 0/);
    expect(result).toContain("all 2 files failed");
    expect(result).toContain("Skipped 2:");
  });
});
