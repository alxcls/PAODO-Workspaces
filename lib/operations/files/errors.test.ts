// The classifier is what makes a file failure actionable by a program rather than only readable by a
// person, so both halves are pinned here: the errno picks the code, and the message names the caller's
// own relative path and nothing else.
//
// The second half is the one worth a real filesystem. libuv builds messages like
//   EACCES: permission denied, open '/data/workspaces/ada/notes.md'
// so a test that constructs a fake `{ code: "EACCES" }` object would pass while the real thing leaked
// the host layout. These provoke the errnos on disk and assert the host path is absent from what a
// client would be shown.

import { describe, it, expect, beforeEach, afterAll } from "vitest";
import fs from "fs";
import fsp from "fs/promises";
import os from "os";
import path from "path";
import { fileSystemAppError, fileSystemCall } from "./errors";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "files-errno-test-"));
const WS_DIR = path.join(ROOT, "ws");

beforeEach(() => {
  fs.rmSync(WS_DIR, { recursive: true, force: true });
  fs.mkdirSync(WS_DIR, { recursive: true });
});

afterAll(() => {
  fs.chmodSync(WS_DIR, 0o755);
  fs.rmSync(ROOT, { recursive: true, force: true });
});

/** The AppError a real filesystem call produced, or null if the call unexpectedly succeeded. */
async function failureOf(relPath: string, run: () => Promise<unknown>) {
  try {
    await fileSystemCall(relPath, run);
  } catch (err) {
    return err as { code?: string; message?: string; details?: unknown };
  }
  return null;
}

describe("fileSystemAppError", () => {
  it("maps a missing file to NOT_FOUND", async () => {
    const failure = await failureOf("notes.md", () => fsp.readFile(path.join(WS_DIR, "notes.md")));
    expect(failure).toMatchObject({ code: "NOT_FOUND", message: "notes.md does not exist" });
  });

  it("maps a directory read as a file to INVALID_REQUEST", async () => {
    fs.mkdirSync(path.join(WS_DIR, "src"));
    const failure = await failureOf("src", () => fsp.readFile(path.join(WS_DIR, "src")));
    expect(failure).toMatchObject({ code: "INVALID_REQUEST", message: "src is a directory, not a file" });
  });

  it("maps a permission failure to FILE_NOT_WRITABLE rather than FORBIDDEN", async () => {
    const target = path.join(WS_DIR, "locked.txt");
    fs.writeFileSync(target, "x");
    fs.chmodSync(target, 0o444);
    try {
      const failure = await failureOf("locked.txt", () => fsp.writeFile(target, "y"));
      // Not FORBIDDEN: that means "you are not authorised", and a client conflating the two would sign
      // the user out over a read-only file.
      expect(failure).toMatchObject({ code: "FILE_NOT_WRITABLE", message: "locked.txt is not writable" });
    } finally {
      fs.chmodSync(target, 0o644);
    }
  });

  it("maps a non-empty directory to CONFLICT", async () => {
    fs.mkdirSync(path.join(WS_DIR, "full"));
    fs.writeFileSync(path.join(WS_DIR, "full", "leaf.txt"), "x");
    const failure = await failureOf("full", () => fsp.rmdir(path.join(WS_DIR, "full")));
    expect(failure).toMatchObject({ code: "CONFLICT" });
  });

  it("names the field so a client can point at the argument that failed", async () => {
    const failure = await failureOf("notes.md", () => fsp.readFile(path.join(WS_DIR, "notes.md")));
    expect(failure?.details).toEqual({ field: "path" });
  });

  // THE test this module exists for. libuv appends the host path to its message; a response built from
  // that message publishes the server's directory layout on a surface whose whole point is that the
  // layout is private.
  it("never carries the host path in the message, for any errno it recognises", async () => {
    const target = path.join(WS_DIR, "locked.txt");
    fs.writeFileSync(target, "x");
    fs.chmodSync(target, 0o444);

    const failures = [
      await failureOf("missing.txt", () => fsp.readFile(path.join(WS_DIR, "missing.txt"))),
      await failureOf("locked.txt", () => fsp.writeFile(target, "y")),
      await failureOf("locked.txt", () => fsp.readdir(target)),
    ];
    fs.chmodSync(target, 0o644);

    for (const failure of failures) {
      expect(failure?.message).toBeTruthy();
      expect(failure?.message).not.toContain(WS_DIR);
      expect(failure?.message).not.toContain(ROOT);
      expect(failure?.message).not.toContain(os.tmpdir());
    }
  });

  it("leaves an errno it has no public answer for unclassified, so the caller answers 500", () => {
    // A caller that turned every failure into a 4xx would report its own bugs as user error.
    expect(fileSystemAppError({ code: "EWHATEVER" }, "x.txt")).toBeNull();
    expect(fileSystemAppError(new Error("not an errno at all"), "x.txt")).toBeNull();
    expect(fileSystemAppError(null, "x.txt")).toBeNull();
  });

  it("passes a non-errno failure through fileSystemCall untouched", async () => {
    const thrown = new Error("bug in our own code");
    await expect(fileSystemCall("x.txt", async () => Promise.reject(thrown))).rejects.toBe(thrown);
  });
});
