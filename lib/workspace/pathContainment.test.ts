// resolveContained is the one piece standing between a caller-supplied relative path and a write
// outside the workspace/drive root — for both the HTTP upload route and (via
// lib/agent/pathUtils.ts) the agent's own file tools. The case that matters most here is a symlink:
// a lexical-only check (normalize + reject "..") cannot see that an in-tree directory secretly
// points somewhere else on disk, but realpath'ing the root and comparing against the resolved target
// does.

import { describe, it, expect, afterAll } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { resolveContained } from "./pathContainment";

// realpathSync up front: on macOS, os.tmpdir() itself is a symlink (/var -> /private/var), and
// resolveContained realpaths the root internally — comparing against the raw (non-realpath'd) path
// would spuriously fail every assertion below on that platform.
const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "path-containment-test-")));
const WORKSPACE = path.join(ROOT, "workspace");
const OUTSIDE = path.join(ROOT, "outside");
fs.mkdirSync(WORKSPACE);
fs.mkdirSync(OUTSIDE);

afterAll(() => fs.rmSync(ROOT, { recursive: true, force: true }));

describe("resolveContained", () => {
  it("resolves a plain relative path under the root", async () => {
    const resolved = await resolveContained(WORKSPACE, "notes.md");
    expect(resolved).toBe(path.join(WORKSPACE, "notes.md"));
  });

  it("resolves a nested path whose intermediate directories don't exist yet", async () => {
    const resolved = await resolveContained(WORKSPACE, "src/deep/new.ts");
    expect(resolved).toBe(path.join(WORKSPACE, "src/deep/new.ts"));
  });

  it("rejects a .. traversal", async () => {
    expect(await resolveContained(WORKSPACE, "../outside/escape.txt")).toBeNull();
  });

  it("rejects an absolute path outside the root", async () => {
    expect(await resolveContained(WORKSPACE, OUTSIDE + "/escape.txt")).toBeNull();
  });

  it("rejects a symlink whose real target is outside the root — the case a lexical-only check misses", async () => {
    const link = path.join(WORKSPACE, "escape-link");
    fs.symlinkSync(OUTSIDE, link);
    // "escape-link/payload.txt" is lexically inside WORKSPACE, but escape-link really points at
    // OUTSIDE — only realpath'ing the root and comparing resolved targets catches this.
    expect(await resolveContained(WORKSPACE, "escape-link/payload.txt")).toBeNull();
  });
});
