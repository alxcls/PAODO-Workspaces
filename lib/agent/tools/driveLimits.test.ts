// Ceilings on the drive tools. These are the app's only host-side reads: drives are never mounted
// into a container, so `fs.readFile` here lands straight in the app's heap with no container limit
// and no capture ceiling above it. Each test below pins one half of the contract — the read is
// bounded, and the refusal says so rather than returning a partial file as if it were whole.
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { MAX_FILE_READ_BYTES, MAX_DRIVE_TRANSFER_BYTES, MAX_DRIVE_LISTING_ENTRIES } from "@/lib/infra/limits";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "drivelimits-test-"));
afterAll(() => fs.rmSync(ROOT, { recursive: true, force: true }));

// driveStore captures WORKSPACES_ROOT at module load, so point it at a clean temp dir and re-import
// the store (and the tools that depend on it) for each test.
async function freshModules() {
  fs.rmSync(ROOT, { recursive: true, force: true });
  fs.mkdirSync(ROOT, { recursive: true });
  process.env.WORKSPACES_ROOT = ROOT;
  vi.resetModules();
  const store = await import("@/lib/drives/store");
  const { DriveReadTool } = await import("./driveRead");
  const { DriveDownloadTool } = await import("./driveDownload");
  const { DriveUploadTool } = await import("./driveUpload");
  const { DriveLsTool } = await import("./driveLs");
  return { store, DriveReadTool, DriveDownloadTool, DriveUploadTool, DriveLsTool };
}

type Mods = Awaited<ReturnType<typeof freshModules>>;
let mods: Mods;

beforeEach(async () => {
  mods = await freshModules();
});

/** Connect a drive to ws1 and return its content dir. */
function seedDrive(name: string): string {
  const drive = mods.store.createDrive(name);
  mods.store.connectDrive(drive.id, "ws1");
  return mods.store.driveContentDir(drive.id);
}

/**
 * A file of `size` bytes that costs no disk: truncate leaves a hole, and every ceiling here is
 * checked against the size stat reports. Without this the transfer tests would each write 50MB.
 */
function sparseFile(absPath: string, size: number): void {
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  fs.closeSync(fs.openSync(absPath, "w"));
  fs.truncateSync(absPath, size);
}

describe("drive_read ceiling", () => {
  it("refuses a file over the ceiling, naming the size and a way through", async () => {
    const dir = seedDrive("notes");
    sparseFile(path.join(dir, "huge.txt"), MAX_FILE_READ_BYTES + 1);

    const result = await new mods.DriveReadTool("ws1").invoke({ drive_name: "notes", path: "huge.txt" });

    expect(result).toMatch(/^Error:/);
    expect(result).toContain("390.6KB"); // the file's actual size, so the agent can judge the gap
    expect(result).toContain("drive_download");
    expect(result).toContain("offset/limit");
  });

  it("reads a file sitting exactly on the ceiling", async () => {
    const dir = seedDrive("notes");
    const text = "a".repeat(MAX_FILE_READ_BYTES);
    fs.writeFileSync(path.join(dir, "exact.txt"), text);

    const result = await new mods.DriveReadTool("ws1").invoke({ drive_name: "notes", path: "exact.txt" });

    // The whole file, not one byte short of it — the +1 in the read must not leak into the result.
    expect(result).toBe(text);
  });
});

describe("drive transfer ceiling", () => {
  it("drive_download refuses an oversized file without writing it", async () => {
    const dir = seedDrive("data");
    sparseFile(path.join(dir, "big.bin"), MAX_DRIVE_TRANSFER_BYTES + 1);
    const workspaceDir = path.join(ROOT, "ws1");
    fs.mkdirSync(workspaceDir, { recursive: true });

    const result = await new mods.DriveDownloadTool("ws1", workspaceDir).invoke({ drive_name: "data", path: "big.bin" });

    expect(result).toMatch(/^Error:/);
    expect(result).toContain("100.0MB");
    // A partial or zero-length file at the dest would be worse than the refusal: the agent would find
    // a file where it expected one and read it as complete.
    expect(fs.existsSync(path.join(workspaceDir, "downloads/data/big.bin"))).toBe(false);
  });

  it("drive_upload refuses an oversized file without creating the destination", async () => {
    const dir = seedDrive("data");
    const workspaceDir = path.join(ROOT, "ws1-files");
    sparseFile(path.join(workspaceDir, "big.bin"), MAX_DRIVE_TRANSFER_BYTES + 1);

    const result = await new mods.DriveUploadTool("ws1", workspaceDir).invoke({
      source_path: "big.bin",
      drive_name: "data",
      dest_path: "big.bin",
    });

    expect(result).toMatch(/^Error:/);
    // A half-written or zero-length file in the drive would be worse than the refusal: the next
    // agent would find a file at the path it expected and read it as complete.
    expect(fs.existsSync(path.join(dir, "big.bin"))).toBe(false);
  });

  it("transfers a file under the ceiling unchanged", async () => {
    const dir = seedDrive("data");
    const workspaceDir = path.join(ROOT, "ws1-files");
    const bytes = Buffer.from([0x00, 0xff, 0x41, 0x00]);
    fs.mkdirSync(workspaceDir, { recursive: true });
    fs.writeFileSync(path.join(workspaceDir, "small.bin"), bytes);

    const result = await new mods.DriveUploadTool("ws1", workspaceDir).invoke({
      source_path: "small.bin",
      drive_name: "data",
    });

    expect(result).toContain("(4 bytes)");
    expect(fs.readFileSync(path.join(dir, "small.bin")).equals(bytes)).toBe(true);
  });
});

describe("drive read bounding, beyond plain size", () => {
  it("refuses a file whose reported size understates it, rather than reading forever", async () => {
    // A character device stats as 0 bytes and yields bytes without end. Reached through a drive it is
    // an unbounded read: the previous fs.readFile would have consumed the heap until the process
    // died. The bound catches it because more arrived than the stat promised — the same signal as a
    // file being written while it is read.
    const dir = seedDrive("notes");
    fs.symlinkSync("/dev/zero", path.join(dir, "endless"));

    const result = await new mods.DriveReadTool("ws1").invoke({ drive_name: "notes", path: "endless" });

    expect(result).toMatch(/^Error:/);
    expect(result).toContain("changed while being read");
  });

  it("still reports a missing file as missing", async () => {
    seedDrive("notes");
    const result = await new mods.DriveReadTool("ws1").invoke({ drive_name: "notes", path: "nope.txt" });
    expect(result).toBe('Error: file not found in drive "notes"');
  });

  it("still reports a directory as a directory", async () => {
    const dir = seedDrive("notes");
    fs.mkdirSync(path.join(dir, "sub"));
    const result = await new mods.DriveReadTool("ws1").invoke({ drive_name: "notes", path: "sub" });
    expect(result).toContain("is a directory");
  });
});

describe("drive_ls ceiling", () => {
  it("caps a large directory and says the set is partial and unordered", async () => {
    const dir = seedDrive("bulk");
    for (let i = 0; i < MAX_DRIVE_LISTING_ENTRIES + 5; i++) {
      fs.writeFileSync(path.join(dir, `f${i}.txt`), "");
    }

    const result = await new mods.DriveLsTool("ws1").invoke({ drive_name: "bulk" });
    const lines = result.split("\n");

    expect(lines).toHaveLength(MAX_DRIVE_LISTING_ENTRIES + 1); // entries + the notice
    expect(lines[lines.length - 1]).toContain("listing truncated");
    // "no particular order" matters: the sort runs after the cut, so an agent must not read this as
    // "everything up to fN" and conclude the rest does not exist.
    expect(lines[lines.length - 1]).toContain("no particular order");
  });

  it("leaves a directory under the ceiling sorted and unannotated", async () => {
    const dir = seedDrive("bulk");
    fs.writeFileSync(path.join(dir, "b.txt"), "");
    fs.writeFileSync(path.join(dir, "a.txt"), "");
    fs.mkdirSync(path.join(dir, "sub"));

    const result = await new mods.DriveLsTool("ws1").invoke({ drive_name: "bulk" });

    expect(result).toBe("sub/\na.txt\nb.txt");
  });
});
