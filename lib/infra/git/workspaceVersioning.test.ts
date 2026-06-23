// WorkspaceVersioning drives git purely through IGitClient, so a recording fake lets us pin the
// exact commands issued without spawning real git. These tests guard the separation invariants
// (force-add-all, external git-dir, identity flags), the run-number/skip-empty logic, and the
// per-workspace serialization.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { WorkspaceVersioning } from "./workspaceVersioning";
import type { GitResult, IGitClient } from "./gitClient";

// _initRepo does a real `mkdir -p` of the git-dir parent, so tests need a writable root.
let ROOT: string;
beforeAll(() => { ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "ver-test-")); });
afterAll(() => { fs.rmSync(ROOT, { recursive: true, force: true }); });
const opts = () => ({ rootDir: ROOT });

type Call = { args: string[] };

// A scriptable fake git. `respond` maps a matcher over the joined args to a canned GitResult;
// the first matching rule wins, else a success with empty stdout. Every call is recorded.
class FakeGit implements IGitClient {
  calls: Call[] = [];
  private rules: { match: (joined: string) => boolean; result: Partial<GitResult> }[];
  constructor(rules: { match: (joined: string) => boolean; result: Partial<GitResult> }[] = []) {
    // Default: HEAD resolves (repo already initialized) so _initRepo is a no-op and commits
    // resolve their sha. Tests that want an uninitialized repo override with code:1. User rules
    // take precedence (first match wins).
    this.rules = [...rules, { match: (j) => j.includes("rev-parse --verify HEAD"), result: { stdout: "HEADSHA" } }];
  }
  run(args: string[]): Promise<GitResult> {
    this.calls.push({ args });
    const joined = args.join(" ");
    const rule = this.rules.find((r) => r.match(joined));
    const base: GitResult = { stdout: "", stderr: "", code: 0 };
    return Promise.resolve({ ...base, ...(rule?.result ?? {}) });
  }
  // Convenience: the subcommand (first non-global token) of the nth recorded call.
  subcommand(n: number): string {
    const args = this.calls[n].args;
    const i = args.findIndex((a, idx) => !a.startsWith("-") && args[idx - 1] !== "--git-dir" && args[idx - 1] !== "--work-tree" && args[idx - 1] !== "-c");
    return args[i];
  }
}

const ID = "ws-1";
const DIR = "/tmp/ws";

function joinedCalls(g: FakeGit): string[] {
  return g.calls.map((c) => c.args.join(" "));
}

describe("WorkspaceVersioning", () => {
  it("snapshots with add --all --force and excludes disabled (ignores user .gitignore)", async () => {
    const git = new FakeGit([{ match: (j) => j.includes("status --porcelain"), result: { stdout: " M file.txt" } }]);
    const ver = new WorkspaceVersioning(git, opts());
    await ver.commitResult(ID, DIR, "did stuff");
    const add = joinedCalls(git).find((j) => j.includes("add --all --force"));
    expect(add).toBeDefined();
    expect(add).toContain("core.excludesFile=/dev/null");
  });

  it("targets an external git-dir keyed on workspaceId, never inside the workspace", async () => {
    const git = new FakeGit();
    const ver = new WorkspaceVersioning(git, opts());
    await ver.initRepo(ID, DIR);
    for (const j of joinedCalls(git)) {
      expect(j).toContain(`--git-dir ${path.join(ROOT, ".versioning", "ws-1")}`);
      expect(j).toContain("--work-tree /tmp/ws");
    }
  });

  it("commits carry the PAODO identity flags", async () => {
    const git = new FakeGit([{ match: (j) => j.includes("status --porcelain"), result: { stdout: " M f" } }]);
    const ver = new WorkspaceVersioning(git, opts());
    await ver.commitBaseline(ID, DIR, "a prompt");
    const commit = joinedCalls(git).find((j) => j.includes(" commit "));
    expect(commit).toContain("user.name=PAODO Agent");
    expect(commit).toContain("user.email=agent@paodo.local");
    expect(commit).toContain("pre-run: a prompt");
  });

  it("commitResult skips the commit and tag when nothing changed", async () => {
    // status --porcelain returns empty ⇒ clean tree.
    const git = new FakeGit([{ match: (j) => j.includes("rev-parse --verify HEAD"), result: { stdout: "abc123" } }]);
    const ver = new WorkspaceVersioning(git, opts());
    const res = await ver.commitResult(ID, DIR, "noop");
    expect(res).toEqual({ sha: "abc123", changed: false });
    expect(joinedCalls(git).some((j) => j.includes(" commit "))).toBe(false);
    expect(joinedCalls(git).some((j) => j.includes(" tag "))).toBe(false);
  });

  it("run number = existing run/* tag count + 1, and tags the result", async () => {
    const git = new FakeGit([
      { match: (j) => j.includes("status --porcelain"), result: { stdout: " M f" } },
      { match: (j) => j.includes("tag --list run/*"), result: { stdout: "run/1\nrun/2" } },
      { match: (j) => j.includes("rev-parse --verify HEAD"), result: { stdout: "newsha" } },
    ]);
    const ver = new WorkspaceVersioning(git, opts());
    const res = await ver.commitResult(ID, DIR, "third run");
    expect(res).toEqual({ sha: "newsha", changed: true });
    const calls = joinedCalls(git);
    expect(calls.some((j) => j.includes("run 3: third run"))).toBe(true);
    expect(calls.some((j) => j.includes("tag run/3 newsha"))).toBe(true);
  });

  it("first run uses run/1 when no tags exist", async () => {
    const git = new FakeGit([
      { match: (j) => j.includes("status --porcelain"), result: { stdout: " M f" } },
      { match: (j) => j.includes("rev-parse --verify HEAD"), result: { stdout: "s1" } },
    ]);
    const ver = new WorkspaceVersioning(git, opts());
    await ver.commitResult(ID, DIR, "first");
    expect(joinedCalls(git).some((j) => j.includes("run 1: first"))).toBe(true);
  });

  it("initRepo skips the initial commit when HEAD already exists (idempotent)", async () => {
    const git = new FakeGit([{ match: (j) => j.includes("rev-parse --verify HEAD"), result: { stdout: "head" } }]);
    const ver = new WorkspaceVersioning(git, opts());
    await ver.initRepo(ID, DIR);
    expect(joinedCalls(git).some((j) => j.includes(" init"))).toBe(true);
    expect(joinedCalls(git).some((j) => j.includes(" commit "))).toBe(false);
  });

  it("initRepo makes a root commit (--allow-empty) when HEAD is absent", async () => {
    // rev-parse --verify HEAD fails (code 1) ⇒ no commits yet.
    const git = new FakeGit([{ match: (j) => j.includes("rev-parse --verify HEAD"), result: { code: 1 } }]);
    const ver = new WorkspaceVersioning(git, opts());
    // headSha after commit also returns 1 here, so commit() will throw — assert it tried though.
    await ver.initRepo(ID, DIR).catch(() => {});
    const calls = joinedCalls(git);
    expect(calls.some((j) => j.includes("add --all --force"))).toBe(true);
    expect(calls.some((j) => j.includes("commit -m init --allow-empty"))).toBe(true);
  });

  it("restore validates the sha before hard-resetting, and rejects unknown shas", async () => {
    const ok = new FakeGit();
    const verOk = new WorkspaceVersioning(ok, opts());
    expect(await verOk.restore(ID, DIR, "abc")).toBe(true);
    const calls = joinedCalls(ok);
    expect(calls.some((j) => j.includes("rev-parse --verify abc^{commit}"))).toBe(true);
    expect(calls.some((j) => j.includes("reset --hard abc"))).toBe(true);

    const bad = new FakeGit([{ match: (j) => j.includes("rev-parse --verify"), result: { code: 1 } }]);
    const verBad = new WorkspaceVersioning(bad, opts());
    expect(await verBad.restore(ID, DIR, "nope")).toBe(false);
    expect(joinedCalls(bad).some((j) => j.includes("reset --hard"))).toBe(false);
  });

  it("history parses the log into structured entries, empty when no commits", async () => {
    const empty = new WorkspaceVersioning(
      new FakeGit([{ match: (j) => j.includes("rev-parse --verify HEAD"), result: { code: 1 } }]),
      opts(),
    );
    expect(await empty.history(ID, DIR)).toEqual([]);

    const log = "deadbeef\x1f1700000000\x1frun 1: hello\x1e\nabad1dea\x1f1699999999\x1fpre-run: hi\x1e";
    const ver = new WorkspaceVersioning(
      new FakeGit([
        { match: (j) => j.includes("rev-parse --verify HEAD"), result: { stdout: "deadbeef" } },
        { match: (j) => j.includes(" log "), result: { stdout: log } },
      ]),
      opts(),
    );
    const entries = await ver.history(ID, DIR);
    expect(entries).toEqual([
      // HEAD is "deadbeef", so only that entry is flagged current.
      { sha: "deadbeef", message: "run 1: hello", timestamp: new Date(1700000000 * 1000).toISOString(), current: true },
      { sha: "abad1dea", message: "pre-run: hi", timestamp: new Date(1699999999 * 1000).toISOString(), current: false },
    ]);
  });

  it("serializes concurrent commits on one workspace (no interleaving)", async () => {
    // A git fake that records call order with a microtask delay, so interleaving would show up.
    const order: string[] = [];
    const slowGit: IGitClient = {
      async run(args: string[]): Promise<GitResult> {
        const joined = args.join(" ");
        if (joined.includes("status --porcelain")) order.push("status");
        if (joined.includes(" commit ")) order.push("commit");
        await Promise.resolve();
        if (joined.includes("status --porcelain")) return { stdout: " M f", stderr: "", code: 0 };
        if (joined.includes("rev-parse --verify HEAD")) return { stdout: "s", stderr: "", code: 0 };
        return { stdout: "", stderr: "", code: 0 };
      },
    };
    const ver = new WorkspaceVersioning(slowGit, opts());
    await Promise.all([ver.commitResult(ID, DIR, "a"), ver.commitResult(ID, DIR, "b")]);
    // Each commitResult does status...then commit; serialized means both statuses don't precede
    // both commits out of order — the first op fully completes its status→commit before the second.
    const firstStatus = order.indexOf("status");
    const firstCommit = order.indexOf("commit");
    expect(firstCommit).toBeGreaterThan(firstStatus);
    // The second status must come after the first commit (no interleave).
    expect(order).toEqual(["status", "commit", "status", "commit"]);
  });
});
