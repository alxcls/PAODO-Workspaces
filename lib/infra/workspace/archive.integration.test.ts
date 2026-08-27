// End-to-end against real git and real tar in a temp root. Validates what fakes cannot: that the
// archive opens with stock tooling, that the manifest leads the tar, and that the home is captured
// whole — every file, matching how the versioning repo captures the workspace tree.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { WorkspaceVersioning } from "../git/workspaceVersioning";
import { archiveWorkspace, verifyArchive } from "./archive";
import { HOME_MEMBER, MANIFEST_MEMBER } from "../../workspace/archive";
import type { Workspace } from "../../workspace/types";

const ID = "ws-archive-int";

function makeWorkspace(dir: string): Workspace {
  return {
    id: ID,
    name: "Reporting Agent",
    dir,
    createdAt: new Date("2026-01-02T03:04:05.000Z"),
    maxIterations: 25,
    maxRunMinutes: 30,
    description: "writes the weekly report",
    llmProvider: "anthropic",
    llmModel: "claude-opus-5",
    internetAccess: true,
  };
}

function listMembers(archive: string): string[] {
  return execFileSync("tar", ["-tf", archive], { encoding: "utf-8" }).trim().split("\n");
}

describe("archiveWorkspace (real git + tar)", () => {
  let root: string;
  let dir: string;
  let out: string;
  let workspace: Workspace;

  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "archive-int-"));
    dir = path.join(root, ID);
    out = path.join(root, "backups");
    fs.mkdirSync(dir, { recursive: true });
    workspace = makeWorkspace(dir);

    fs.writeFileSync(path.join(dir, "AGENTS.md"), "# instructions\n");
    const versioning = new WorkspaceVersioning(undefined, { rootDir: root });
    await versioning.initRepo(ID, dir);
    // Written after the initial snapshot so the run actually changes something and earns a commit.
    fs.writeFileSync(path.join(dir, "report.md"), "quarterly numbers\n");
    await versioning.commitResult(ID, dir, "run 1");

    const home = path.join(root, ".homes", ID);
    fs.mkdirSync(path.join(home, ".ssh"), { recursive: true });
    fs.mkdirSync(path.join(home, ".config", "gh"), { recursive: true });
    fs.mkdirSync(path.join(home, ".cache"), { recursive: true });
    fs.mkdirSync(path.join(home, ".nvm"), { recursive: true });
    fs.writeFileSync(path.join(home, ".ssh", "id_ed25519"), "PRIVATE KEY the proxy never stands in for");
    fs.writeFileSync(path.join(home, ".config", "gh", "hosts.yml"), "oauth_token: __pxy_ws_GITHUB__\n");
    fs.writeFileSync(path.join(home, ".cache", "blob"), "derivable");
    fs.writeFileSync(path.join(home, ".nvm", "alias"), "default 22");
    fs.writeFileSync(path.join(home, ".bashrc"), "export PATH=$PATH\n");
    fs.writeFileSync(path.join(root, ".homes", `${ID}.apt.json`), JSON.stringify({ packages: ["ripgrep"] }));
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it("writes every member and leads the tar with the manifest", async () => {
    const result = await archiveWorkspace(workspace, out, { rootDir: root });

    expect(listMembers(result.path)).toEqual(["manifest.json", "config.json", "apt.json", "files.bundle", HOME_MEMBER]);
    expect(result.manifest.workspace.id).toBe(ID);
    expect(result.manifest.config.llmModel).toBe("claude-opus-5");
  });

  it("carries every setting a rebuild has to reproduce", async () => {
    const { manifest } = await archiveWorkspace(workspace, out, { rootDir: root });

    expect(manifest.workspace.description).toBe("writes the weekly report");
    expect(manifest.config).toEqual({
      llmProvider: "anthropic",
      llmModel: "claude-opus-5",
      reasoningEffort: undefined,
      maxIterations: 25,
      maxRunMinutes: 30,
      internetAccess: true,
    });
  });

  it("records internet access when it is off, rather than dropping the field", async () => {
    const offline = { ...workspace, internetAccess: false };
    const { manifest } = await archiveWorkspace(offline, out, { rootDir: root });

    expect(manifest.config.internetAccess).toBe(false);
  });

  it("names the archive inside a destination directory that does not exist yet", async () => {
    const result = await archiveWorkspace(workspace, out, { rootDir: root });

    expect(path.dirname(result.path)).toBe(out);
    expect(path.basename(result.path)).toMatch(/^paodo-ws-reporting-agent-ws-archive-int-.*\.tar$/);
  });

  it("uses an explicit .tar destination verbatim", async () => {
    const explicit = path.join(out, "nightly.tar");
    const result = await archiveWorkspace(workspace, explicit, { rootDir: root });

    expect(result.path).toBe(explicit);
  });

  it("reads the manifest without unpacking the archive", async () => {
    const { path: archive } = await archiveWorkspace(workspace, out, { rootDir: root });
    const raw = execFileSync("tar", ["-xOf", archive, MANIFEST_MEMBER], { encoding: "utf-8" });
    expect(JSON.parse(raw).workspace.name).toBe("Reporting Agent");
  });

  it("captures the home whole — every file, no exclusions", async () => {
    const { path: archive } = await archiveWorkspace(workspace, out, { rootDir: root });
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "archive-home-"));
    execFileSync("tar", ["-xf", archive, "-C", scratch, HOME_MEMBER]);
    const members = execFileSync("tar", ["-tzf", path.join(scratch, HOME_MEMBER)], { encoding: "utf-8" });

    expect(members).toContain("./.nvm/alias");
    expect(members).toContain("./.bashrc");
    expect(members).toContain("./.cache/blob");
    expect(members).toContain("./.ssh/id_ed25519");
    expect(members).toContain("./.config/gh/hosts.yml");
    fs.rmSync(scratch, { recursive: true, force: true });
  });

  it("carries the snapshot history, not just the working tree", async () => {
    const { path: archive } = await archiveWorkspace(workspace, out, { rootDir: root });
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "archive-bundle-"));
    execFileSync("tar", ["-xf", archive, "-C", scratch, "files.bundle"]);

    const clone = path.join(scratch, "restored");
    execFileSync("git", ["clone", "-q", path.join(scratch, "files.bundle"), clone]);
    expect(fs.readFileSync(path.join(clone, "report.md"), "utf-8")).toBe("quarterly numbers\n");
    const log = execFileSync("git", ["-C", clone, "log", "--oneline"], { encoding: "utf-8" });
    expect(log).toContain("run 1");
    fs.rmSync(scratch, { recursive: true, force: true });
  });

  it("verifies a good archive and rejects a tampered one", async () => {
    const { path: archive } = await archiveWorkspace(workspace, out, { rootDir: root });
    expect((await verifyArchive(archive)).ok).toBe(true);

    // Repack with an altered member: the manifest still claims the original hash, which is exactly
    // the drift verify exists to catch.
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "archive-tamper-"));
    execFileSync("tar", ["-xf", archive, "-C", scratch]);
    fs.appendFileSync(path.join(scratch, "config.json"), "\n");
    const corrupted = path.join(root, "corrupted.tar");
    execFileSync("tar", ["-cf", corrupted, "-C", scratch, ...listMembers(archive)]);

    const checked = await verifyArchive(corrupted);
    expect(checked.ok).toBe(false);
    expect(checked.problems.join(" ")).toMatch(/config\.json/);
    fs.rmSync(scratch, { recursive: true, force: true });
  });

  it("never overwrites an existing archive", async () => {
    const first = await archiveWorkspace(workspace, out, { rootDir: root });
    await expect(archiveWorkspace(workspace, first.path, { rootDir: root })).rejects.toThrow(/Refusing to overwrite/);
  });

  it("archives a workspace that has no snapshots yet", async () => {
    fs.rmSync(path.join(root, ".versioning"), { recursive: true, force: true });
    const result = await archiveWorkspace(workspace, out, { rootDir: root });
    expect(listMembers(result.path)).not.toContain("files.bundle");
    expect((await verifyArchive(result.path)).ok).toBe(true);
  });
});
