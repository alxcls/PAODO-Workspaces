// End-to-end against real git in a temp dir. Validates the invariants the fakes can't: that the
// external git-dir keeps the workspace tree free of `.git`, that force-add-all captures files a
// user `.gitignore` would normally exclude, and that baseline→result→restore actually move bytes
// on disk. Gated as *.integration.test.ts (run via `npm run test:integration`); needs a real git.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { WorkspaceVersioning } from "./workspaceVersioning";

const ID = "ws-int";

describe("WorkspaceVersioning (real git)", () => {
  let root: string;
  let dir: string;
  let ver: WorkspaceVersioning;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "ver-int-"));
    dir = path.join(root, "workspace");
    fs.mkdirSync(dir, { recursive: true });
    ver = new WorkspaceVersioning(undefined, { rootDir: root });
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it("never creates a .git inside the workspace tree", async () => {
    await ver.initRepo(ID, dir);
    expect(fs.existsSync(path.join(dir, ".git"))).toBe(false);
    expect(fs.existsSync(path.join(root, ".versioning", ID, "HEAD"))).toBe(true);
  });

  it("captures files a user .gitignore would exclude", async () => {
    const { sha: baseline } = await ver.commitBaseline(ID, dir, "first prompt");
    // The user/agent adds an ignore rule AND the very file it ignores, mid-run.
    fs.writeFileSync(path.join(dir, ".gitignore"), "secret.txt\n");
    fs.writeFileSync(path.join(dir, "secret.txt"), "classified");
    const res = await ver.commitResult(ID, dir, "captured everything");
    expect(res.changed).toBe(true);
    // The result commit's tree must contain secret.txt despite .gitignore (force-add wins).
    const diff = await ver.diff(ID, dir, baseline, res.sha);
    expect(diff).toContain("secret.txt");
  });

  it("baseline → change → result yields a run/1 tag, then restore reverts on disk", async () => {
    await ver.commitBaseline(ID, dir, "set up");
    const baseline = (await ver.history(ID, dir))[0].sha;

    fs.writeFileSync(path.join(dir, "app.txt"), "v1");
    const result = await ver.commitResult(ID, dir, "add app.txt");
    expect(result.changed).toBe(true);

    const history = await ver.history(ID, dir);
    expect(history[0].message).toMatch(/^run 1: add app\.txt/);

    // Restoring to the baseline removes the file from the actual workspace dir.
    expect(await ver.restore(ID, dir, baseline)).toBe(true);
    expect(fs.existsSync(path.join(dir, "app.txt"))).toBe(false);
  });

  it("skips a result commit when the run changed nothing", async () => {
    await ver.commitBaseline(ID, dir, "noop run");
    const before = await ver.history(ID, dir);
    const res = await ver.commitResult(ID, dir, "nothing happened");
    expect(res.changed).toBe(false);
    const after = await ver.history(ID, dir);
    expect(after.length).toBe(before.length);
  });

  it("deleteRepo destroys the version history on disk", async () => {
    await ver.commitBaseline(ID, dir, "set up");
    const gitDir = path.join(root, ".versioning", ID);
    expect(fs.existsSync(gitDir)).toBe(true);
    await ver.deleteRepo(ID);
    expect(fs.existsSync(gitDir)).toBe(false);
  });

  it("coexists with the agent's own nested git repo without error", async () => {
    await ver.commitBaseline(ID, dir, "before nested");
    // Simulate the agent running its own `git init` for a project inside the workspace.
    const proj = path.join(dir, "proj");
    fs.mkdirSync(proj);
    fs.writeFileSync(path.join(proj, "main.py"), "print('hi')");
    const res = await ver.commitResult(ID, dir, "agent made a project");
    expect(res.changed).toBe(true);
    // Our versioning history is intact and independent.
    expect((await ver.history(ID, dir)).length).toBeGreaterThanOrEqual(2);
  });
});
