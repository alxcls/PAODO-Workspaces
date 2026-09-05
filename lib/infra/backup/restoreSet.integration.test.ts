// End-to-end against real tar, git and sqlite: build a full set, wipe live state as a disaster would,
// then restore and prove the box is back — tree, home, db row, registry and graph, at the original id.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { execFileSync } from "child_process";
import type { Workspace } from "../../workspace/types";

const DEPLOYMENT = "restore-test";
const WS_ID = "ws-restore-int";
const WS_NAME = "Restore Agent";

let root: string;
let out: string;

function clearSingletons(): void {
  const g = global as typeof global & { __singletons?: Record<string, unknown> };
  if (g.__singletons) delete g.__singletons.workspaceGraph;
}

function makeWorkspace(): Workspace {
  return {
    id: WS_ID,
    name: WS_NAME,
    dir: path.join(root, WS_ID),
    createdAt: new Date("2026-02-03T04:05:06.000Z"),
    maxIterations: 20,
    maxRunMinutes: 30,
    internetAccess: false,
  };
}

function git(args: string[]): void {
  execFileSync("git", args, { stdio: ["ignore", "pipe", "pipe"] });
}

function seedFilesystem(): void {
  const wsDir = path.join(root, WS_ID);
  fs.mkdirSync(wsDir, { recursive: true });
  fs.writeFileSync(path.join(wsDir, "project.txt"), "original project content\n");

  const gitDir = path.join(root, ".versioning", WS_ID);
  fs.mkdirSync(path.dirname(gitDir), { recursive: true });
  git(["--git-dir", gitDir, "init", "-q"]);
  git(["--git-dir", gitDir, "--work-tree", wsDir, "add", "--all"]);
  git(["--git-dir", gitDir, "--work-tree", wsDir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init"]);

  const home = path.join(root, ".homes", WS_ID);
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, ".bashrc"), "export ORIGINAL=1\n");

  fs.writeFileSync(
    path.join(root, ".workspace-graph.json"),
    JSON.stringify({ edges: [{ id: "call_x", source: WS_ID, target: WS_ID }], positions: { [WS_ID]: { col: 1, row: 2 } } }),
  );
  fs.writeFileSync(
    path.join(root, ".workspaces.json"),
    JSON.stringify(
      [{ id: WS_ID, name: WS_NAME, createdAt: "2026-02-03T04:05:06.000Z", maxIterations: 20, maxRunMinutes: 30, internetAccess: false }],
      null,
      2,
    ),
  );

  fs.writeFileSync(
    path.join(root, ".drives.json"),
    JSON.stringify([{ id: "drive-1", name: "Shared", createdAt: "2026-02-03T04:05:06.000Z" }]),
  );
  fs.writeFileSync(
    path.join(root, ".drive-connections.json"),
    JSON.stringify([{ id: "link_1", driveId: "drive-1", workspaceId: WS_ID }]),
  );
  const driveContent = path.join(root, ".drives", "drive-1");
  fs.mkdirSync(driveContent, { recursive: true });
  fs.writeFileSync(path.join(driveContent, "shared.txt"), "drive payload\n");
}

async function freshModules() {
  clearSingletons();
  process.env.WORKSPACES_ROOT = root;
  process.env.PAODO_DEPLOYMENT = DEPLOYMENT;
  vi.resetModules();
  return {
    archiveSet: (await import("./set")).archiveSet,
    restoreSet: (await import("./restoreSet")).restoreSet,
    database: await import("../../data/database"),
  };
}

function wipeLiveState(invalidate: () => void): void {
  invalidate();
  for (const rel of [WS_ID, ".versioning", ".homes", ".workspace-graph.json", ".workspaces.json", ".drives.json", ".drive-connections.json", ".drives"]) {
    fs.rmSync(path.join(root, rel), { recursive: true, force: true });
  }
  for (const sfx of ["", "-wal", "-shm"]) fs.rmSync(path.join(root, `.paodo.db${sfx}`), { force: true });
}

describe("restoreSet (real tar/git/sqlite)", () => {
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "set-restore-"));
    out = path.join(root, "backups");
    seedFilesystem();
  });

  afterEach(() => {
    clearSingletons();
    delete process.env.PAODO_DEPLOYMENT;
    delete process.env.WORKSPACES_ROOT;
    fs.rmSync(root, { recursive: true, force: true });
  });

  async function buildSet() {
    const { archiveSet, restoreSet, database } = await freshModules();
    database
      .appDataDb()
      .prepare(
        `INSERT INTO conversations (workspace_id, id, title, created_at, updated_at, last_message_at, messages_json)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(WS_ID, "conv-1", "Hello", "t", "t", "t", "[]");
    const { setDir } = await archiveSet(out, { rootDir: root, image: { ref: "img", hash: "h" }, workspaces: [makeWorkspace()] });
    return { setDir, restoreSet, database };
  }

  it("round-trips a full set back to its captured state", async () => {
    const { setDir, restoreSet, database } = await buildSet();

    wipeLiveState(database.invalidateAppDataDb);
    expect(fs.existsSync(path.join(root, WS_ID))).toBe(false);

    const result = await restoreSet(setDir, { rootDir: root, force: true });
    expect(result.workspaces).toEqual([{ id: WS_ID, name: WS_NAME }]);

    expect(fs.readFileSync(path.join(root, WS_ID, "project.txt"), "utf-8")).toBe("original project content\n");
    expect(fs.readFileSync(path.join(root, ".homes", WS_ID, ".bashrc"), "utf-8")).toBe("export ORIGINAL=1\n");
    expect(fs.existsSync(path.join(root, `.homes/${WS_ID}.seeded`))).toBe(true);

    const graph = JSON.parse(fs.readFileSync(path.join(root, ".workspace-graph.json"), "utf-8"));
    expect(graph.edges).toEqual([{ id: "call_x", source: WS_ID, target: WS_ID }]);

    const registry = JSON.parse(fs.readFileSync(path.join(root, ".workspaces.json"), "utf-8"));
    expect(registry[0]).toMatchObject({ id: WS_ID, name: WS_NAME });

    const drives = JSON.parse(fs.readFileSync(path.join(root, ".drives.json"), "utf-8"));
    expect(drives[0]).toMatchObject({ id: "drive-1", name: "Shared" });
    const connections = JSON.parse(fs.readFileSync(path.join(root, ".drive-connections.json"), "utf-8"));
    expect(connections[0]).toMatchObject({ driveId: "drive-1", workspaceId: WS_ID });
    expect(fs.readFileSync(path.join(root, ".drives", "drive-1", "shared.txt"), "utf-8")).toBe("drive payload\n");

    const row = database.appDataDb().prepare("SELECT title FROM conversations WHERE workspace_id = ?").get(WS_ID) as
      | { title: string }
      | undefined;
    expect(row?.title).toBe("Hello");
  });

  it("restores the versioning history so future snapshots still work", async () => {
    const { setDir, restoreSet, database } = await buildSet();
    wipeLiveState(database.invalidateAppDataDb);
    await restoreSet(setDir, { rootDir: root, force: true });

    const gitDir = path.join(root, ".versioning", WS_ID);
    const log = execFileSync("git", ["--git-dir", gitDir, "log", "--oneline"], { encoding: "utf-8" });
    expect(log).toMatch(/init/);
  });

  it("overwrites a workspace whose live home holds a read-only dir (go module cache)", async () => {
    const { setDir, restoreSet, database } = await buildSet();
    database.invalidateAppDataDb();

    const readOnly = path.join(root, ".homes", WS_ID, "gopath", "pkg", "mod", "dep@v1");
    fs.mkdirSync(readOnly, { recursive: true });
    fs.writeFileSync(path.join(readOnly, "go.mod"), "module dep\n");
    fs.chmodSync(readOnly, 0o555);

    await expect(restoreSet(setDir, { rootDir: root, force: true })).resolves.toBeTruthy();
    expect(fs.existsSync(path.join(root, ".homes", WS_ID, "gopath"))).toBe(false);
    expect(fs.readFileSync(path.join(root, ".homes", WS_ID, ".bashrc"), "utf-8")).toBe("export ORIGINAL=1\n");
    database.invalidateAppDataDb();
  });

  it("aborts before writing a byte when an archive is corrupt", async () => {
    const { setDir, restoreSet, database } = await buildSet();

    const graphArchive = fs.readdirSync(setDir).find((f) => f.startsWith("paodo-graph-"))!;
    fs.appendFileSync(path.join(setDir, graphArchive), "corruption");

    const target = fs.mkdtempSync(path.join(os.tmpdir(), "restore-target-"));
    await expect(restoreSet(setDir, { rootDir: target, force: true })).rejects.toThrow(/failed verification/);
    expect(fs.existsSync(path.join(target, ".paodo.db"))).toBe(false);
    expect(fs.existsSync(path.join(target, WS_ID))).toBe(false);
    fs.rmSync(target, { recursive: true, force: true });
    database.invalidateAppDataDb();
  });

  it("restores a legacy set that predates the drives component", async () => {
    const { setDir, restoreSet, database } = await buildSet();

    const manifestPath = path.join(setDir, "backup.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
    manifest.entries = manifest.entries.filter((e: { kind: string }) => e.kind !== "drives");
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

    wipeLiveState(database.invalidateAppDataDb);
    await expect(restoreSet(setDir, { rootDir: root, force: true })).resolves.toBeTruthy();
    expect(fs.existsSync(path.join(root, ".drives.json"))).toBe(false);
    expect(fs.existsSync(path.join(root, WS_ID))).toBe(true);
    database.invalidateAppDataDb();
  });

  it("prunes a workspace that drifted in after the snapshot", async () => {
    const { setDir, restoreSet, database } = await buildSet();

    // The box moves forward: a second workspace B appears on disk and in the registry after capture.
    const bDir = path.join(root, "ws-B");
    const bHome = path.join(root, ".homes", "ws-B");
    fs.mkdirSync(bDir, { recursive: true });
    fs.writeFileSync(path.join(bDir, "b.txt"), "b content\n");
    fs.mkdirSync(bHome, { recursive: true });
    fs.writeFileSync(
      path.join(root, ".workspaces.json"),
      JSON.stringify([
        { id: WS_ID, name: WS_NAME },
        { id: "ws-B", name: "Drifted" },
      ]),
    );
    database.invalidateAppDataDb();

    const result = await restoreSet(setDir, { rootDir: root, force: true });
    expect(result.pruned).toEqual(["ws-B"]);
    expect(fs.existsSync(bDir)).toBe(false);
    expect(fs.existsSync(bHome)).toBe(false);
    expect(fs.existsSync(path.join(root, WS_ID))).toBe(true);
    database.invalidateAppDataDb();
  });

  it("refuses a set from another deployment without force", async () => {
    const { setDir, restoreSet, database } = await buildSet();
    process.env.PAODO_DEPLOYMENT = "somewhere-else";
    await expect(restoreSet(setDir, { rootDir: root })).rejects.toThrow(/another deployment|not "somewhere-else"/);
    database.invalidateAppDataDb();
  });
});
