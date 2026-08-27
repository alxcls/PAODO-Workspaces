// Captures one workspace as a single portable tar. Free of docker and network concerns: the caller
// supplies image identity, so this module is filesystem plus git and nothing else.
import { spawn } from "child_process";
import { createHash } from "crypto";
import { createReadStream } from "fs";
import { mkdir, mkdtemp, copyFile, rm, stat, writeFile, access } from "fs/promises";
import os from "os";
import path from "path";
import { SpawnCapture } from "../spawnCapture";
import { createAuditLogger, createLogger } from "../logger";
import { WORKSPACES_ROOT, workspaceHomeDir, workspaceAptRecipeFile } from "../paths";
import { GitClient, type IGitClient } from "../git/gitClient";
import {
  ARCHIVE_SCHEMA_VERSION,
  APT_MEMBER,
  CONFIG_MEMBER,
  FILES_MEMBER,
  HOME_MEMBER,
  MANIFEST_MEMBER,
  MEMBER_ORDER,
  type ArchiveImage,
  type ArchiveManifest,
  type ArchiveMember,
} from "../../workspace/archive";
import type { Workspace } from "../../workspace/types";

const log = createLogger("archive");
const audit = createAuditLogger("archive");

/** Stores that exist but are deliberately not captured, recorded in the manifest for restore. */
const UNBACKED_STORES = ["workspace-secrets", "mcp-tokens", "provider-keys"];

export interface ArchiveOptions {
  /** Root holding workspace dirs, `.versioning/` and `.homes/`. Overridable for tests. */
  rootDir?: string;
  image?: ArchiveImage;
  paodoCommit?: string | null;
  git?: IGitClient;
}

export interface ArchiveResult {
  path: string;
  bytes: number;
  manifest: ArchiveManifest;
}

interface CommandResult {
  stdout: string;
  stderr: string;
  code: number;
}

function run(cmd: string, args: string[]): Promise<CommandResult> {
  return new Promise((resolve) => {
    const captured = new SpawnCapture();
    let proc: ReturnType<typeof spawn>;
    try {
      proc = spawn(cmd, args);
    } catch (err) {
      resolve({ stdout: "", stderr: (err as Error).message, code: 1 });
      return;
    }
    captured.attach(proc);
    proc.on("close", (code) =>
      resolve({ stdout: captured.stdout.trim(), stderr: captured.stderr.trim(), code: code ?? 1 }),
    );
    proc.on("error", (err) => resolve({ stdout: "", stderr: err.message, code: 1 }));
    proc.stdin!.end();
  });
}

/**
 * ENOENT is the only absence this tool may infer. A permission error on a home owned by uid 1000
 * would otherwise read as "nothing to back up" and drop the largest member from a passing archive.
 */
async function exists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw new Error(`cannot read ${target}: ${(err as Error).message}`);
  }
}

function sha256File(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

/** Filesystem-safe workspace name for the archive filename; the id keeps it unambiguous. */
function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "workspace"
  );
}

export function archiveFileName(workspace: Workspace, at: Date): string {
  const stamp = at
    .toISOString()
    .replace(/[:.]/g, "-")
    .replace(/-\d{3}Z$/, "Z");
  return `paodo-ws-${slugify(workspace.name)}-${workspace.id}-${stamp}.tar`;
}

/**
 * Resolves the destination. A path ending in `.tar` is the archive itself; anything else is a
 * directory that gets a generated filename, whether or not it exists yet — so a destination that
 * has not been created cannot silently become a file named after the folder that was meant.
 * Never overwrites: clobbering a good backup with a failed one is the mistake to design out.
 */
async function resolveDestination(dest: string, workspace: Workspace, at: Date): Promise<string> {
  const resolved = path.resolve(dest);
  const isFile = resolved.endsWith(".tar") && !(await stat(resolved).catch(() => null))?.isDirectory();
  const target = isFile ? resolved : path.join(resolved, archiveFileName(workspace, at));
  if (await exists(target)) throw new Error(`Refusing to overwrite an existing archive: ${target}`);
  await mkdir(path.dirname(target), { recursive: true });
  return target;
}

/**
 * Bundles the workspace's snapshot history. A workspace whose versioning repo has no commits yet
 * yields no member rather than a failure — `git bundle` refuses to write an empty bundle.
 */
async function writeFilesBundle(git: IGitClient, gitDir: string, out: string): Promise<boolean> {
  if (!(await exists(gitDir))) return false;
  const refs = await git.run(["--git-dir", gitDir, "for-each-ref", "--count=1", "--format=%(refname)"]);
  if (refs.code !== 0 || !refs.stdout) return false;
  const bundle = await git.run(["--git-dir", gitDir, "bundle", "create", out, "--all"]);
  if (bundle.code !== 0) throw new Error(`git bundle failed: ${bundle.stderr || bundle.stdout}`);
  return true;
}

/**
 * Tars the durable home whole — every file, no exclusions, matching how the versioning repo
 * captures the workspace tree. Exit 1 is tar's "file changed as we read it" warning, expected on a
 * live home and not a reason to fail the backup.
 */
async function writeHomeArchive(homeDir: string, out: string): Promise<boolean> {
  if (!(await exists(homeDir))) return false;
  const result = await run("tar", ["-czf", out, "-C", homeDir, "."]);
  if (result.code > 1) throw new Error(`tar of home failed: ${result.stderr || result.stdout}`);
  if (result.code === 1) log.warn({ event: "archive_home_changed_during_read", homeDir }, result.stderr);
  return true;
}

function configOf(workspace: Workspace): ArchiveManifest["config"] {
  return {
    llmProvider: workspace.llmProvider,
    llmModel: workspace.llmModel,
    reasoningEffort: workspace.reasoningEffort,
    maxIterations: workspace.maxIterations,
    maxRunMinutes: workspace.maxRunMinutes,
    internetAccess: workspace.internetAccess,
  };
}

async function describeMembers(stageDir: string, names: string[]): Promise<ArchiveMember[]> {
  return Promise.all(
    names.map(async (name) => {
      const member = path.join(stageDir, name);
      return { name, bytes: (await stat(member)).size, sha256: await sha256File(member) };
    }),
  );
}

/**
 * Writes a portable archive of one workspace: config, snapshot history, durable home and apt
 * recipe. Nothing inside carries an absolute host path or assumes the id is free on the target,
 * so the result restores onto a different tenant.
 */
export async function archiveWorkspace(
  workspace: Workspace,
  dest: string,
  opts: ArchiveOptions = {},
): Promise<ArchiveResult> {
  const root = opts.rootDir ?? WORKSPACES_ROOT;
  const git = opts.git ?? new GitClient();
  const capturedAt = new Date();
  const target = await resolveDestination(dest, workspace, capturedAt);
  const stageDir = await mkdtemp(path.join(os.tmpdir(), "paodo-archive-"));

  try {
    const present: string[] = [CONFIG_MEMBER];
    await writeFile(path.join(stageDir, CONFIG_MEMBER), JSON.stringify(configOf(workspace), null, 2));

    const recipe = workspaceAptRecipeFile(workspace.id, root);
    if (await exists(recipe)) {
      await copyFile(recipe, path.join(stageDir, APT_MEMBER));
      present.push(APT_MEMBER);
    }

    const gitDir = path.join(root, ".versioning", workspace.id);
    if (await writeFilesBundle(git, gitDir, path.join(stageDir, FILES_MEMBER))) present.push(FILES_MEMBER);

    const homeDir = workspaceHomeDir(workspace.id, root);
    if (await writeHomeArchive(homeDir, path.join(stageDir, HOME_MEMBER))) present.push(HOME_MEMBER);

    const manifest: ArchiveManifest = {
      schemaVersion: ARCHIVE_SCHEMA_VERSION,
      workspace: {
        id: workspace.id,
        name: workspace.name,
        description: workspace.description,
        createdAt: workspace.createdAt.toISOString(),
      },
      config: configOf(workspace),
      source: { host: os.hostname(), capturedAt: capturedAt.toISOString(), paodoCommit: opts.paodoCommit ?? null },
      image: opts.image ?? { ref: process.env.CONTAINER_IMAGE ?? "paodo-workspace", hash: null },
      contents: await describeMembers(stageDir, present),
      omitted: { stores: UNBACKED_STORES },
    };
    await writeFile(path.join(stageDir, MANIFEST_MEMBER), JSON.stringify(manifest, null, 2));

    const ordered = MEMBER_ORDER.filter((name) => name === MANIFEST_MEMBER || present.includes(name));
    const tarred = await run("tar", ["-cf", target, "-C", stageDir, ...ordered]);
    if (tarred.code !== 0) throw new Error(`tar of archive failed: ${tarred.stderr || tarred.stdout}`);

    const bytes = (await stat(target)).size;
    audit.info(
      { event: "workspace_archived", workspaceId: workspace.id, path: target, bytes, members: ordered },
      "workspace archived",
    );
    return { path: target, bytes, manifest };
  } finally {
    await rm(stageDir, { recursive: true, force: true });
  }
}

export interface VerifyResult {
  ok: boolean;
  manifest: ArchiveManifest;
  problems: string[];
}

/**
 * Sizes and hashes one member straight off tar's stdout. Streamed rather than extracted because a
 * multi-gigabyte home would otherwise need that much scratch disk on a host already short of it,
 * and buffering it would blow the capture ceiling `run` exists to enforce.
 */
function measureMember(archivePath: string, member: string): Promise<{ bytes: number; sha256: string } | null> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    let bytes = 0;
    let proc: ReturnType<typeof spawn>;
    try {
      proc = spawn("tar", ["-xOf", archivePath, member]);
    } catch (err) {
      reject(err as Error);
      return;
    }
    proc.stdout!.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      hash.update(chunk);
    });
    proc.stdout!.on("error", () => {});
    proc.stderr!.resume();
    proc.on("error", reject);
    proc.on("close", (code) => resolve(code === 0 ? { bytes, sha256: hash.digest("hex") } : null));
  });
}

/**
 * Reads the manifest out of an archive and checks every member against its recorded hash. Restore
 * lands in a later branch; until then this is what makes a backup trustworthy rather than assumed.
 */
export async function verifyArchive(archivePath: string): Promise<VerifyResult> {
  const resolved = path.resolve(archivePath);
  const read = await run("tar", ["-xOf", resolved, MANIFEST_MEMBER]);
  if (read.code !== 0) throw new Error(`cannot read ${MANIFEST_MEMBER} from ${resolved}: ${read.stderr}`);
  const manifest = JSON.parse(read.stdout) as ArchiveManifest;

  const problems: string[] = [];
  if (manifest.schemaVersion > ARCHIVE_SCHEMA_VERSION) {
    problems.push(`archive schema ${manifest.schemaVersion} is newer than this build understands`);
  }

  for (const member of manifest.contents) {
    const measured = await measureMember(resolved, member.name);
    if (!measured) {
      problems.push(`${member.name}: missing from archive`);
      continue;
    }
    if (measured.bytes !== member.bytes) {
      problems.push(`${member.name}: ${measured.bytes} bytes, manifest says ${member.bytes}`);
    }
    if (measured.sha256 !== member.sha256) problems.push(`${member.name}: sha256 mismatch`);
  }

  return { ok: problems.length === 0, manifest, problems };
}
