// Tests for the workspace path containment guard (pathUtils.ts).

import { describe, it, expect, afterAll } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { normalizeRelpath, normalizeDirPath, resolveWorkspacePath, containWorkspacePath } from "./pathUtils";

// The single most important invariant in this app: the agent can never
// address a path outside its own workspace. normalizeRelpath/normalizeDirPath
// are the chokepoint that enforces it — every file tool routes through here.
// These tests assert BEHAVIOR (input -> allowed-or-rejected), so they survive
// any reimplementation of the guard's internals.

describe("normalizeRelpath — containment guard", () => {
  it("allows ordinary relative paths", () => {
    expect(normalizeRelpath("src/index.ts")).toBe("src/index.ts");
    expect(normalizeRelpath("a/b/c.txt")).toBe("a/b/c.txt");
  });

  it("collapses redundant segments to a clean relative path", () => {
    expect(normalizeRelpath("src/./a/../b.ts")).toBe("src/b.ts");
  });

  // --- the cases that matter: escapes MUST be rejected (null) ---

  it("rejects parent-directory traversal", () => {
    expect(normalizeRelpath("../secret")).toBeNull();
    expect(normalizeRelpath("a/../../etc/passwd")).toBeNull();
    expect(normalizeRelpath("..")).toBeNull();
  });

  it("rejects absolute paths", () => {
    expect(normalizeRelpath("/etc/passwd")).toBeNull();
    expect(normalizeRelpath("/")).toBeNull();
  });

  // The agent is told /workspace is its working directory and uses that form freely in shell
  // commands, so it reaches for it here too. It names the same file a relative path does.
  it("accepts the container's own /workspace form and returns it relative", () => {
    expect(normalizeRelpath("/workspace/hello.py")).toBe("hello.py");
    expect(normalizeRelpath("/workspace/src/index.ts")).toBe("src/index.ts");
    expect(normalizeRelpath("/workspace/src/./a/../b.ts")).toBe("src/b.ts");
  });

  it("rejects the workspace root itself, which is a directory and not a file", () => {
    expect(normalizeRelpath("/workspace")).toBeNull();
    expect(normalizeRelpath("/workspace/")).toBeNull();
  });

  // The prefix must match on a path boundary, and must be judged after normalization — otherwise
  // "/workspace/../etc/passwd" would trim to a path that reads as contained.
  it("rejects paths that only look like they start at the workspace root", () => {
    expect(normalizeRelpath("/workspacefoo/x")).toBeNull();
    expect(normalizeRelpath("/workspace-other/x")).toBeNull();
    expect(normalizeRelpath("/workspace/../etc/passwd")).toBeNull();
    expect(normalizeRelpath("/workspace/a/../../etc/passwd")).toBeNull();
  });
});

describe("normalizeDirPath — containment guard", () => {
  it("treats empty/current as the workspace root", () => {
    expect(normalizeDirPath(undefined)).toBe(".");
    expect(normalizeDirPath(".")).toBe(".");
  });

  it("allows ordinary subdirectories", () => {
    expect(normalizeDirPath("src/components")).toBe("src/components");
  });

  it("rejects escapes", () => {
    expect(normalizeDirPath("..")).toBeNull();
    expect(normalizeDirPath("../..")).toBeNull();
    expect(normalizeDirPath("/var")).toBeNull();
    expect(normalizeDirPath("/workspacefoo")).toBeNull();
    expect(normalizeDirPath("/workspace/../etc")).toBeNull();
  });

  // Unlike a file path, the root is a legitimate directory to name — it is the listing the agent
  // asks for most often, and "/workspace" is how the prompt spells it.
  it("accepts the container's own /workspace form, root included", () => {
    expect(normalizeDirPath("/workspace")).toBe(".");
    expect(normalizeDirPath("/workspace/")).toBe(".");
    expect(normalizeDirPath("/workspace/src/components")).toBe("src/components");
  });
});

describe("resolveWorkspacePath — realpath-based containment", () => {
  const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "path-utils-test-")));
  const WORKSPACE = path.join(ROOT, "workspace");
  const OUTSIDE = path.join(ROOT, "outside");
  fs.mkdirSync(WORKSPACE);
  fs.mkdirSync(OUTSIDE);

  afterAll(() => fs.rmSync(ROOT, { recursive: true, force: true }));

  it("resolves an ordinary path that doesn't exist yet — the common case for a new agent-written file", async () => {
    const resolved = await resolveWorkspacePath(WORKSPACE, "src/new-file.ts");
    expect(resolved).toBe(path.join(WORKSPACE, "src/new-file.ts"));
  });

  it("rejects a lexical escape before touching the filesystem", async () => {
    expect(await resolveWorkspacePath(WORKSPACE, "../outside/escape.txt")).toBeNull();
  });

  it("rejects a symlink planted inside the workspace that redirects outside — what normalizeRelpath alone cannot catch", async () => {
    fs.symlinkSync(OUTSIDE, path.join(WORKSPACE, "escape-link"));
    expect(await resolveWorkspacePath(WORKSPACE, "escape-link/payload.txt")).toBeNull();
  });
});

describe("containWorkspacePath — normalize + contain in one step", () => {
  const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "path-utils-test-")));
  const WORKSPACE = path.join(ROOT, "workspace");
  const OUTSIDE = path.join(ROOT, "outside");
  fs.mkdirSync(WORKSPACE);
  fs.mkdirSync(OUTSIDE);

  afterAll(() => fs.rmSync(ROOT, { recursive: true, force: true }));

  it("returns the normalized relpath for a legitimate path", async () => {
    expect(await containWorkspacePath(WORKSPACE, "src/./a/../b.ts")).toBe("src/b.ts");
  });

  // The relpath it hands back is what the container write is built from, so the /workspace form
  // has to come out of here relative — not merely be allowed through.
  it("returns a relpath for the container's /workspace form, against a host dir that is named differently", async () => {
    expect(await containWorkspacePath(WORKSPACE, "/workspace/src/b.ts")).toBe("src/b.ts");
  });

  it("rejects a lexical escape", async () => {
    expect(await containWorkspacePath(WORKSPACE, "../outside/escape.txt")).toBeNull();
  });

  it("rejects a symlink escape", async () => {
    fs.symlinkSync(OUTSIDE, path.join(WORKSPACE, "escape-link"));
    expect(await containWorkspacePath(WORKSPACE, "escape-link/payload.txt")).toBeNull();
  });
});
