// Registry of shared drives and their connections to workspaces.
//
// A *drive* is a named shared directory on disk that can be connected to multiple workspaces so
// their agents can exchange files. Drives are PASSIVE storage: their content lives at
// data/.drives/<driveId>/ and is NEVER mounted into any container — only host-side fs touches it.
// This keeps the security promise that only sandboxed workspaces execute code.
//
// Drive↔workspace connections are stored here, SEPARATELY from the agent-call graph
// (workspaceGraph.ts), whose edges drive list_agents/call_agent and must stay a clean DAG.
//
// Accessors read fresh from disk on every call. The files are tiny, and reading fresh avoids the
// stale-cache problem across Next.js module instances (the agent runner and the API routes may be
// bundled separately), so a drive connected via the API is immediately visible to a new agent run.
import path from "path";
import fs from "fs";
import { rm } from "fs/promises";
import { WORKSPACES_ROOT } from "../infra/paths";
import { atomicSaveJson } from "../infra/jsonPersist";
import { createLogger } from "../infra/logger";

const log = createLogger("driveStore");

export interface Drive {
  id: string;
  name: string;
  description?: string;
  createdAt: string;
}

export interface DriveConnection {
  id: string;
  driveId: string;
  workspaceId: string;
  sourceHandle?: string;
  targetHandle?: string;
}

const DRIVES_FILE = path.join(WORKSPACES_ROOT, ".drives.json");
const CONNECTIONS_FILE = path.join(WORKSPACES_ROOT, ".drive-connections.json");
const DRIVES_DIR = path.join(WORKSPACES_ROOT, ".drives");

function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8")) as T;
  } catch (err) {
    // Missing files are normal before the first drive/connection is created. Corruption,
    // permissions, and other I/O failures must not make every drive silently disappear.
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      log.error({ err, file }, "failed to load drive registry — using fallback");
    }
    return fallback;
  }
}

/** Absolute host path holding a drive's files. Keyed by UUID, so it is rename-safe. */
export function driveContentDir(driveId: string): string {
  return path.join(DRIVES_DIR, driveId);
}

/**
 * One-line rendering of a drive for an agent: `- <name> (id: <id>)<desc>`. The id is surfaced so
 * an agent can pass it on to the next agent as a stable handle (drive tools accept id or name).
 * Shared by the system-prompt drives block and the drive_ls listing so they never drift.
 */
export function formatDriveLine(drive: Drive): string {
  return `- ${drive.name} (id: ${drive.id})${drive.description ? ` — ${drive.description}` : ""}`;
}

export function listDrives(): Drive[] {
  return readJson<Drive[]>(DRIVES_FILE, []);
}

export function listConnections(): DriveConnection[] {
  return readJson<DriveConnection[]>(CONNECTIONS_FILE, []);
}

export function getDrive(driveId: string): Drive | undefined {
  return listDrives().find((d) => d.id === driveId);
}

// The name never hits the drive's own path (that is keyed by UUID), but drive_download writes into
// the workspace at downloads/<drive-name>/..., so the name must be a safe single path segment.
function assertSafeDriveName(name: string): void {
  const trimmed = name.trim();
  // Forbid path separators and control characters — the name is used as a path segment under
  // downloads/<drive-name>/. Hyphens and underscores are allowed.
  const hasUnsafeChar = /[/\\\x00-\x1f]/.test(trimmed);
  if (!trimmed || trimmed.length > 100 || trimmed === "." || trimmed === ".." || hasUnsafeChar) {
    throw new Error(`Invalid drive name: "${name}"`);
  }
}

export function createDrive(name: string, description?: string): Drive {
  assertSafeDriveName(name);
  const drive: Drive = {
    id: crypto.randomUUID(),
    name: name.trim(),
    description: description?.trim() || undefined,
    createdAt: new Date().toISOString(),
  };
  fs.mkdirSync(driveContentDir(drive.id), { recursive: true });
  const drives = listDrives();
  drives.push(drive);
  atomicSaveJson(DRIVES_FILE, drives);
  log.info({ id: drive.id, name: drive.name }, "created drive");
  return drive;
}

export function updateDrive(driveId: string, patch: { name?: string; description?: string }): Drive | undefined {
  const drives = listDrives();
  const drive = drives.find((d) => d.id === driveId);
  if (!drive) return undefined;
  if (patch.name !== undefined) {
    assertSafeDriveName(patch.name);
    drive.name = patch.name.trim();
  }
  if (patch.description !== undefined) {
    drive.description = patch.description.trim() || undefined;
  }
  atomicSaveJson(DRIVES_FILE, drives);
  return drive;
}

export async function deleteDrive(driveId: string): Promise<boolean> {
  const drives = listDrives();
  const next = drives.filter((d) => d.id !== driveId);
  if (next.length === drives.length) return false;
  atomicSaveJson(DRIVES_FILE, next);
  // Drop every connection that referenced this drive.
  const connections = listConnections().filter((c) => c.driveId !== driveId);
  atomicSaveJson(CONNECTIONS_FILE, connections);
  // Remove the drive's files last; best-effort, registry is already consistent.
  try {
    await rm(driveContentDir(driveId), { recursive: true, force: true });
  } catch (err) {
    log.warn({ err, driveId }, "failed to remove drive content dir");
  }
  log.info({ driveId }, "deleted drive");
  return true;
}

/**
 * Connect a drive to a workspace. Only one link per pair exists; reconnecting updates the chosen
 * handle positions so the rendered edge stays where the user attached it.
 */
export function connectDrive(
  driveId: string,
  workspaceId: string,
  handles?: { sourceHandle?: string; targetHandle?: string },
): DriveConnection {
  const connections = listConnections();
  const existing = connections.find((c) => c.driveId === driveId && c.workspaceId === workspaceId);
  if (existing) {
    existing.sourceHandle = handles?.sourceHandle;
    existing.targetHandle = handles?.targetHandle;
    atomicSaveJson(CONNECTIONS_FILE, connections);
    return existing;
  }
  const connection: DriveConnection = {
    id: crypto.randomUUID(),
    driveId,
    workspaceId,
    sourceHandle: handles?.sourceHandle,
    targetHandle: handles?.targetHandle,
  };
  connections.push(connection);
  atomicSaveJson(CONNECTIONS_FILE, connections);
  return connection;
}

export function disconnectDrive(connectionId: string): boolean {
  const connections = listConnections();
  const next = connections.filter((c) => c.id !== connectionId);
  if (next.length === connections.length) return false;
  atomicSaveJson(CONNECTIONS_FILE, next);
  return true;
}

/** Remove all drive connections for a deleted workspace. */
export function disconnectWorkspace(workspaceId: string): void {
  const connections = listConnections();
  const next = connections.filter((c) => c.workspaceId !== workspaceId);
  if (next.length !== connections.length) atomicSaveJson(CONNECTIONS_FILE, next);
}

/** Drives connected to a given workspace — the set an agent can see and address by name. */
export function getDrivesForWorkspace(workspaceId: string): Drive[] {
  const driveIds = new Set(
    listConnections()
      .filter((c) => c.workspaceId === workspaceId)
      .map((c) => c.driveId),
  );
  return listDrives().filter((d) => driveIds.has(d.id));
}

/**
 * Resolve a drive reference (its id OR its name) to its content dir, scoped to what THIS
 * workspace is connected to. The id (a UUID) is the stable key agents pass between each other;
 * the name is matched case-insensitively as a human-friendly fallback. These never collide:
 * drive names forbid hyphens (assertSafeDriveName) while UUIDs always contain them.
 * Returns null when the workspace has no connected drive matching the reference.
 */
export function resolveDriveDir(workspaceId: string, driveRef: string): { drive: Drive; dir: string } | null {
  const ref = driveRef.trim();
  const wantedName = ref.toLowerCase();
  const drive = getDrivesForWorkspace(workspaceId).find((d) => d.id === ref || d.name.toLowerCase() === wantedName);
  if (!drive) return null;
  return { drive, dir: driveContentDir(drive.id) };
}
