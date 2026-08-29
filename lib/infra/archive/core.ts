// The mechanics every archive shares: staging, hashing, tarring, destination rules and verification.
// Knows nothing about workspaces or databases — callers stage a directory and hand over a member list.
import { spawn, execFileSync } from "child_process";
import { createHash } from "crypto";
import { createReadStream } from "fs";
import { mkdir, stat, access } from "fs/promises";
import os from "os";
import path from "path";
import { SpawnCapture } from "../spawnCapture";
import {
  ARCHIVE_SCHEMA_VERSIONS,
  MANIFEST_MEMBER,
  type ArchiveManifest,
  type TarMember,
  type ArchiveSource,
} from "../../archive/manifest";

export interface CommandResult {
  stdout: string;
  stderr: string;
  code: number;
}

export function run(cmd: string, args: string[]): Promise<CommandResult> {
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
export async function exists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw new Error(`cannot read ${target}: ${(err as Error).message}`);
  }
}

export function sha256File(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

/** Filesystem-safe fragment for an archive filename. */
export function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "unnamed"
  );
}

/** Filename-safe instant: `2026-08-27T20-45-20Z`. Sorts chronologically as plain text. */
export function archiveStamp(at: Date): string {
  return at
    .toISOString()
    .replace(/[:.]/g, "-")
    .replace(/-\d{3}Z$/, "Z");
}

/**
 * Which build produced the archive. The env var is what a deployed container has; the git call is
 * the dev fallback, since the image ships no .git.
 */
export function paodoCommit(): string | null {
  if (process.env.PAODO_COMMIT?.trim()) return process.env.PAODO_COMMIT.trim();
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

/**
 * Names the deployment this backup belongs to. Deliberately fatal when unset: an unlabelled archive
 * is one you cannot tell apart from a laptop's at the moment you most need to.
 */
export function deploymentName(): string {
  const name = process.env.PAODO_DEPLOYMENT?.trim();
  if (!name) {
    throw new Error("PAODO_DEPLOYMENT is not set. Every archive must name the deployment it came from.");
  }
  return name;
}

export function archiveSource(capturedAt: Date): ArchiveSource {
  return {
    deployment: deploymentName(),
    host: os.hostname(),
    capturedAt: capturedAt.toISOString(),
    paodoCommit: paodoCommit(),
  };
}

/** Every suffix these commands write. A destination ending in one was meant as a file, not a folder. */
const ARCHIVE_SUFFIXES = [".tar.gz", ".tar"];

/**
 * Resolves the destination. A path ending in `suffix` is the archive itself; anything else is a
 * directory that gets a generated filename, whether or not it exists yet — so a destination that has
 * not been created cannot silently become a file named after the folder that was meant. Asking for
 * the wrong archive suffix is an error rather than a directory of that name, which is the shape the
 * mistake used to take. Never overwrites: clobbering a good backup with a failed one is designed out.
 */
export async function resolveDestination(dest: string, suffix: string, fileName: () => string): Promise<string> {
  const resolved = path.resolve(dest);
  const named = ARCHIVE_SUFFIXES.find((candidate) => resolved.endsWith(candidate));
  const isDirectory = (await stat(resolved).catch(() => null))?.isDirectory() === true;
  if (named && !isDirectory && named !== suffix) {
    throw new Error(`This command writes ${suffix} archives, but ${resolved} asks for ${named}.`);
  }
  const isFile = named !== undefined && !isDirectory;
  const target = isFile ? resolved : path.join(resolved, fileName());
  if (await exists(target)) throw new Error(`Refusing to overwrite an existing archive: ${target}`);
  await mkdir(path.dirname(target), { recursive: true });
  return target;
}

export async function describeMembers(stageDir: string, names: string[]): Promise<TarMember[]> {
  return Promise.all(
    names.map(async (name) => {
      const member = path.join(stageDir, name);
      return { name, bytes: (await stat(member)).size, sha256: await sha256File(member) };
    }),
  );
}

/** Packs the staged members in the given order and returns the archive's size. */
export async function writeArchive(
  stageDir: string,
  members: string[],
  target: string,
  opts: { gzip?: boolean } = {},
): Promise<number> {
  const result = await run("tar", [opts.gzip ? "-czf" : "-cf", target, "-C", stageDir, ...members]);
  if (result.code !== 0) throw new Error(`tar of archive failed: ${result.stderr || result.stdout}`);
  return (await stat(target)).size;
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
  const known = ARCHIVE_SCHEMA_VERSIONS[manifest.kind];
  if (known === undefined) {
    problems.push(`archive kind "${manifest.kind}" is not one this build understands`);
  } else if (manifest.schemaVersion > known) {
    problems.push(`${manifest.kind} archive schema ${manifest.schemaVersion} is newer than this build understands`);
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
