// The download route zips a caller-selected set of paths. A directory with no files anywhere
// beneath it is easy to lose: JSZip only materializes a folder once something is placed inside it,
// so without an explicit folder entry an empty dir (e.g. a fresh `.skills/`) silently vanishes from
// the archive. These tests pin that empty and empty-only directories survive the download.

import { describe, it, expect, afterAll, beforeEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import JSZip from "jszip";
import { addSelectedToZip } from "./zipDownload";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "ws-zip-test-"));
const WS_DIR = path.join(ROOT, "ws");

beforeEach(() => {
  fs.rmSync(WS_DIR, { recursive: true, force: true });
  fs.mkdirSync(WS_DIR, { recursive: true });
});

afterAll(() => fs.rmSync(ROOT, { recursive: true, force: true }));

const noSkip = () => {};

/** Directory (`dir: true`) and file entry names present in the generated archive. */
async function zipEntries(paths: string[], rootFolder?: string) {
  const zip = new JSZip();
  await addSelectedToZip(zip, WS_DIR, paths, noSkip, rootFolder);
  await zip.generateAsync({ type: "nodebuffer" });
  const files: string[] = [];
  const dirs: string[] = [];
  for (const [name, entry] of Object.entries(zip.files)) (entry.dir ? dirs : files).push(name);
  return { files, dirs };
}

describe("addSelectedToZip", () => {
  it("keeps a selected empty directory in the archive", async () => {
    fs.mkdirSync(path.join(WS_DIR, "empty"));
    const { dirs } = await zipEntries([path.join(WS_DIR, "empty")]);
    expect(dirs).toContain("empty/");
  });

  it("keeps a directory that contains only an empty subdirectory (the .skills case)", async () => {
    fs.mkdirSync(path.join(WS_DIR, ".skills", "sub"), { recursive: true });
    const { dirs } = await zipEntries([path.join(WS_DIR, ".skills")]);
    expect(dirs).toContain(".skills/");
    expect(dirs).toContain(".skills/sub/");
  });

  it("still includes files and recurses into non-empty directories", async () => {
    fs.mkdirSync(path.join(WS_DIR, "src"));
    fs.writeFileSync(path.join(WS_DIR, "root.txt"), "a");
    fs.writeFileSync(path.join(WS_DIR, "src", "index.ts"), "b");
    const { files } = await zipEntries([path.join(WS_DIR, "root.txt"), path.join(WS_DIR, "src")]);
    expect(files).toContain("root.txt");
    expect(files).toContain("src/index.ts");
  });

  it("nests every entry under rootFolder so a single file extracts inside a named folder", async () => {
    fs.writeFileSync(path.join(WS_DIR, "root.txt"), "a");
    const { files } = await zipEntries([path.join(WS_DIR, "root.txt")], "My Workspace");
    expect(files).toContain("My Workspace/root.txt");
    expect(files).not.toContain("root.txt");
  });

  it("nests directory trees under rootFolder", async () => {
    fs.mkdirSync(path.join(WS_DIR, "src"));
    fs.writeFileSync(path.join(WS_DIR, "src", "index.ts"), "b");
    const { files, dirs } = await zipEntries([path.join(WS_DIR, "src")], "My Workspace");
    expect(files).toContain("My Workspace/src/index.ts");
    expect(dirs).toContain("My Workspace/");
  });
});
