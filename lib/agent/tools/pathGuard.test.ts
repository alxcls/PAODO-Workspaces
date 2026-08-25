// pathUtils.test.ts proves normalizeRelpath rejects traversal/absolute paths in isolation. This
// file proves the file tools actually WIRE that guard: every file tool must run the containment
// check and bail BEFORE issuing any container exec when the path escapes the workspace. The bug
// class is a tool that forgets the guard (or guards one code path but not another) — the guard
// can be perfect and the sandbox still leak. So the assertion is twofold: an escaping path (a)
// returns the "outside the workspace" error and (b) never reaches runner.exec, while a normal
// relative path does reach it.
//
// execCommand is deliberately NOT covered here: it has no path guard by design — it runs
// arbitrary bash and its containment is the non-root container sandbox itself, exercised by the
// docker integration tier, not normalizeRelpath.

import { describe, it, expect, vi, beforeEach } from "vitest";
import os from "os";
import { FileReadTool } from "./fileRead";
import { FileWriteTool } from "./fileWrite";
import { FileEditTool } from "./fileEdit";
import type { ExecRunner } from "../interfaces";

// FileWriteTool/FileEditTool now also realpath-check against a real workspaceDir (see
// lib/files/containment.ts), so this needs a real, existing directory — the OS temp dir
// always exists and nothing is actually written under it (runner.exec is mocked below).
const WORKSPACE_DIR = os.tmpdir();

// Records every exec so we can assert it was NEVER called on an escaping path. Returns code 0 so
// the legitimate-path cases proceed far enough to issue at least one exec.
function makeRunner() {
  const exec = vi.fn(async () => ({ code: 0, stdout: "", stderr: "" }));
  return { runner: { exec } as ExecRunner, exec };
}

const noopBroadcast = () => {};

// Paths that must all be rejected: parent traversal, absolute, a sneaky path that only escapes
// after normalization collapses the `..` segments, and two that borrow the workspace root's name
// without actually starting at it.
const ESCAPING = [
  "../etc/passwd",
  "/etc/passwd",
  "foo/../../etc/passwd",
  "/workspacefoo/x",
  "/workspace/../etc/passwd",
];

// protected _call invoked directly — we are testing the guard, not zod/invoke wrapping.
type Callable = { _call(input: unknown): Promise<string> };
const callOf = (t: unknown) => (t as unknown as Callable)._call.bind(t);

describe("file tools wire the workspace containment guard", () => {
  let exec: ReturnType<typeof makeRunner>["exec"];
  let runner: ExecRunner;
  beforeEach(() => {
    ({ runner, exec } = makeRunner());
  });

  // Each entry: a tool, plus how to build its _call args from a file_path. fileEdit appears twice
  // because its create branch (old_string === "") and edit branch are separate code paths that
  // both reach exec — the guard must cover both.
  const cases: { name: string; call: (filePath: string) => Promise<string> }[] = [
    { name: "file_read", call: (file_path) => callOf(new FileReadTool(runner))({ file_path }) },
    {
      name: "file_write",
      call: (file_path) => callOf(new FileWriteTool(runner, WORKSPACE_DIR, noopBroadcast))({ file_path, content: "x" }),
    },
    {
      name: "file_edit (edit branch)",
      call: (file_path) =>
        callOf(new FileEditTool(runner, WORKSPACE_DIR, noopBroadcast))({ file_path, old_string: "a", new_string: "b" }),
    },
    {
      name: "file_edit (create branch)",
      call: (file_path) =>
        callOf(new FileEditTool(runner, WORKSPACE_DIR, noopBroadcast))({ file_path, old_string: "", new_string: "b" }),
    },
  ];

  for (const { name, call } of cases) {
    describe(name, () => {
      for (const bad of ESCAPING) {
        it(`rejects "${bad}" without touching the container`, async () => {
          const result = await call(bad);
          expect(result).toMatch(/outside the workspace/i);
          expect(exec).not.toHaveBeenCalled();
        });
      }

      it("reaches the container for a legitimate relative path", async () => {
        await call("src/index.ts");
        expect(exec).toHaveBeenCalled();
      });

      // The prompt calls the working directory /workspace, so the agent addresses files that way.
      // The guard used to reject it alongside real escapes, costing a turn on every first write.
      it("reaches the container for the container's own /workspace form", async () => {
        await call("/workspace/src/index.ts");
        expect(exec).toHaveBeenCalled();
      });
    });
  }
});
