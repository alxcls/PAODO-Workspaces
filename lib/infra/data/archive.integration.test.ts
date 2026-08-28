// End-to-end against real sqlite and real tar in a temp root. The case that matters is the
// write-ahead log: almost all of a live database sits there, so a plain file copy produces an
// archive that opens cleanly and is nearly empty.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { execFileSync } from "child_process";
import Database from "better-sqlite3";
import fs from "fs";
import os from "os";
import path from "path";

const DEPLOYMENT = "test-deployment";
const WORKSPACE_ID = "ws-db-archive";

type ClosableDb = { open: boolean; close(): void };

function closeGlobalDb(): void {
  const g = global as Record<string, unknown>;
  const conn = g._paodoDataDb as ClosableDb | undefined;
  if (conn?.open) conn.close();
  delete g._paodoDataDb;
  delete g._paodoDataDbFile;
}

let root: string;
let out: string;

/** Re-imports under a fresh WORKSPACES_ROOT, the pattern database.test.ts established. */
async function freshModules() {
  closeGlobalDb();
  process.env.WORKSPACES_ROOT = root;
  process.env.PAODO_DEPLOYMENT = DEPLOYMENT;
  vi.resetModules();
  const [archive, database] = await Promise.all([import("./archive"), import("../../data/database")]);
  return { ...archive, ...database };
}

function seedConversation(db: InstanceType<typeof Database>, id: string): void {
  db.prepare(
    `INSERT INTO conversations (workspace_id, id, title, created_at, updated_at, last_message_at, messages_json)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(WORKSPACE_ID, id, "a conversation", "2026-01-01", "2026-01-01", "2026-01-01", "[]");
}

function listMembers(archive: string): string[] {
  return execFileSync("tar", ["-tzf", archive], { encoding: "utf-8" }).trim().split("\n");
}

function extract(archive: string, member: string): string {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "db-archive-out-"));
  execFileSync("tar", ["-xzf", archive, "-C", scratch, member]);
  return path.join(scratch, member);
}

describe("archiveDatabase (real sqlite + tar)", () => {
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "db-archive-"));
    out = path.join(root, "backups");
    fs.writeFileSync(path.join(root, ".workspaces.json"), JSON.stringify([{ id: WORKSPACE_ID, name: "Reporting" }]));
  });

  afterEach(() => {
    closeGlobalDb();
    delete process.env.PAODO_DEPLOYMENT;
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("writes the manifest first, then the database and registry", async () => {
    const { archiveDatabase } = await freshModules();
    const result = await archiveDatabase(out);

    expect(listMembers(result.path)).toEqual(["manifest.json", "paodo.db", "workspaces.json"]);
    expect(result.manifest.kind).toBe("database");
    expect(result.manifest.source.deployment).toBe(DEPLOYMENT);
  });

  it("captures rows still sitting in the write-ahead log", async () => {
    const { archiveDatabase, appDataDb } = await freshModules();
    const live = appDataDb();
    for (let i = 0; i < 50; i += 1) seedConversation(live, `conv-${i}`);

    // The live file is still tiny — everything written above is in .paodo.db-wal, which is exactly
    // the state a naive copy would capture as an empty database.
    expect(fs.statSync(path.join(root, ".paodo.db")).size).toBeLessThan(
      fs.statSync(path.join(root, ".paodo.db-wal")).size,
    );

    const result = await archiveDatabase(out);
    const copy = new Database(extract(result.path, "paodo.db"), { readonly: true });
    const count = copy.prepare("SELECT count(*) AS n FROM conversations").get() as { n: number };
    copy.close();

    expect(count.n).toBe(50);
  });

  it("records the schema version the database was on", async () => {
    const { archiveDatabase, appDataDb } = await freshModules();
    const expected = appDataDb().pragma("user_version", { simple: true });

    const { manifest } = await archiveDatabase(out);
    expect(manifest.database.userVersion).toBe(expected);
  });

  it("verifies a good archive and rejects a tampered one", async () => {
    const { archiveDatabase } = await freshModules();
    const { verifyArchive } = await import("../archive/core");
    const result = await archiveDatabase(out);
    expect((await verifyArchive(result.path)).ok).toBe(true);

    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "db-archive-tamper-"));
    execFileSync("tar", ["-xzf", result.path, "-C", scratch]);
    fs.appendFileSync(path.join(scratch, "workspaces.json"), "\n");
    const corrupted = path.join(root, "corrupted.tar.gz");
    execFileSync("tar", ["-czf", corrupted, "-C", scratch, ...listMembers(result.path)]);

    const checked = await verifyArchive(corrupted);
    expect(checked.ok).toBe(false);
    expect(checked.problems.join(" ")).toMatch(/workspaces\.json/);
  });

  /** The manifest is not one of the hashed members, so a rewritten one is caught by kind, not sha. */
  it("reports an archive whose kind this build has never heard of", async () => {
    const { archiveDatabase } = await freshModules();
    const { verifyArchive } = await import("../archive/core");
    const result = await archiveDatabase(out);

    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "db-archive-kind-"));
    execFileSync("tar", ["-xzf", result.path, "-C", scratch]);
    const manifestFile = path.join(scratch, "manifest.json");
    const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf-8")) as Record<string, unknown>;
    fs.writeFileSync(manifestFile, JSON.stringify({ ...manifest, kind: "sorcery" }));
    const odd = path.join(root, "odd.tar.gz");
    execFileSync("tar", ["-czf", odd, "-C", scratch, ...listMembers(result.path)]);

    const checked = await verifyArchive(odd);
    expect(checked.ok).toBe(false);
    expect(checked.problems.join(" ")).toMatch(/kind "sorcery"/);
  });

  it("archives an instance that has no registry yet", async () => {
    fs.rmSync(path.join(root, ".workspaces.json"));
    const { archiveDatabase } = await freshModules();
    const { verifyArchive } = await import("../archive/core");

    const result = await archiveDatabase(out);
    expect(listMembers(result.path)).not.toContain("workspaces.json");
    expect((await verifyArchive(result.path)).ok).toBe(true);
  });

  it("never overwrites an existing archive", async () => {
    const { archiveDatabase } = await freshModules();
    const first = await archiveDatabase(out);
    await expect(archiveDatabase(first.path)).rejects.toThrow(/Refusing to overwrite/);
  });

  it("refuses to write an archive that does not name its deployment", async () => {
    const { archiveDatabase } = await freshModules();
    delete process.env.PAODO_DEPLOYMENT;
    await expect(archiveDatabase(out)).rejects.toThrow(/PAODO_DEPLOYMENT/);
  });
});
