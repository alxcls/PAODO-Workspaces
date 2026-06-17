// assertInsideWorkspace is the host-side chokepoint shared by the file-content and serve routes.
// The bug class it guards: a path that points outside the workspace dir — either directly, or via
// a symlink planted INSIDE the workspace that resolves out (the realpath step exists precisely for
// the symlink case; a naive string-prefix check would be fooled by it). These tests pin both the
// rejection and the legitimate pass-through against a real on-disk fixture, so the routes that wire
// this guard inherit a tested boundary instead of each re-proving it.

import { describe, it, expect, afterAll } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { assertInsideWorkspace } from "./workspaceContainment";

// <root>/
//   secret.txt        <- OUTSIDE the workspace (host secret)
//   ws/               <- the workspace dir
//     hello.txt       <- a legitimate file
//     escape          <- symlink -> ../secret.txt
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "ws-containment-test-"));
const WS_DIR = path.join(ROOT, "ws");
fs.mkdirSync(WS_DIR);
fs.writeFileSync(path.join(WS_DIR, "hello.txt"), "hi");
fs.writeFileSync(path.join(ROOT, "secret.txt"), "TOPSECRET");
fs.symlinkSync(path.join(ROOT, "secret.txt"), path.join(WS_DIR, "escape"));

afterAll(() => fs.rmSync(ROOT, { recursive: true, force: true }));

describe("assertInsideWorkspace", () => {
  it("returns the resolved path for a file inside the workspace", async () => {
    const resolved = await assertInsideWorkspace(WS_DIR, path.join(WS_DIR, "hello.txt"));
    expect(resolved).toBe(fs.realpathSync(path.join(WS_DIR, "hello.txt")));
  });

  // THE case that matters: a symlink inside the workspace pointing out must be rejected. A
  // prefix-only check (no realpath) would pass this and leak the host file.
  it("rejects a symlink that escapes the workspace", async () => {
    await expect(assertInsideWorkspace(WS_DIR, path.join(WS_DIR, "escape"))).rejects.toThrow(/outside workspace/i);
  });

  it("rejects an absolute path outside the workspace", async () => {
    await expect(assertInsideWorkspace(WS_DIR, path.join(ROOT, "secret.txt"))).rejects.toThrow(/outside workspace/i);
  });

  // A not-yet-existing path is allowed as long as its parent dir is inside the workspace — this is
  // the write-a-new-file case (realpath throws on the leaf, so the parent is resolved instead).
  it("allows a non-existent path whose parent is inside the workspace", async () => {
    const target = path.join(WS_DIR, "new-file.txt");
    // The guard reconstructs from the realpath'd parent, so compare against that (on macOS the
    // tmpdir's /var is a symlink to /private/var).
    expect(await assertInsideWorkspace(WS_DIR, target)).toBe(path.join(fs.realpathSync(WS_DIR), "new-file.txt"));
  });
});
