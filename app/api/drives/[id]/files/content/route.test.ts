// The drive file-content route shares its core with the workspace route but runs on a BARE
// backend: no container write-fallback and, more importantly here, no afterWrite git snapshot.
// These tests pin the drive-specific wiring — that PATCH is reachable, stays contained, and does
// not depend on the workspace-only hooks.

import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

// Same shape as the workspace fixture: a drive content dir with a host secret next to it.
const fixture = vi.hoisted(() => ({ driveDir: "" }));
let DRIVE_DIR: string;

beforeAll(() => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "drive-content-test-"));
  DRIVE_DIR = path.join(root, "drive-1");
  fixture.driveDir = DRIVE_DIR;
  fs.mkdirSync(DRIVE_DIR);
  fs.writeFileSync(path.join(root, "secret.txt"), "TOPSECRET");
});

vi.mock("@/lib/workspace/driveStore", () => ({
  getDrive: (id: string) =>
    (id === "drive-1" ? { id: "drive-1", name: "shared", createdAt: "" } : undefined),
  driveContentDir: () => fixture.driveDir,
}));

import { PATCH } from "./route";
import { buildTree } from "@/lib/workspace/fileTree";

const patchMove = (body: unknown, id = "drive-1") =>
  PATCH(new Request("http://x/api/drives/files/content", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }), { params: Promise.resolve({ id }) });

afterAll(() => fs.rmSync(path.dirname(DRIVE_DIR), { recursive: true, force: true }));

describe("drives files/content PATCH — move", () => {
  it("moves a file within the drive", async () => {
    const destinationDirectory = path.join(DRIVE_DIR, "sorted");
    fs.mkdirSync(destinationDirectory);
    fs.writeFileSync(path.join(DRIVE_DIR, "report.csv"), "a,b");

    const sourcePath = (await buildTree(DRIVE_DIR)).find((n) => n.name === "report.csv")!.path;
    const res = await patchMove({ sourcePath, destinationDirectory });

    expect(res.status).toBe(200);
    // Drives are passive storage with no snapshot hook — the move still completes without one.
    expect((await res.json()).path)
      .toBe(path.join(destinationDirectory, "report.csv"));
    expect(fs.readFileSync(path.join(destinationDirectory, "report.csv"), "utf8")).toBe("a,b");
    expect(fs.existsSync(sourcePath)).toBe(false);
  });

  it("rejects a destination outside the drive", async () => {
    const sourcePath = path.join(DRIVE_DIR, "keep.txt");
    fs.writeFileSync(sourcePath, "safe");

    const res = await patchMove({ sourcePath, destinationDirectory: path.dirname(DRIVE_DIR) });

    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/outside workspace/i);
    expect(fs.readFileSync(sourcePath, "utf8")).toBe("safe");
  });

  it("404s for an unknown drive", async () => {
    const res = await patchMove({ sourcePath: path.join(DRIVE_DIR, "keep.txt") }, "nope");
    expect(res.status).toBe(404);
  });
});
