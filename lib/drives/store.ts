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
import { validateDriveName } from "./name";

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
      log.error(
        { event: "drive_registry_load_failed", outcome: "fallback_used", err, filePath: file },
        "failed to load drive registry — using fallback",
      );
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

function saveConnections(
  connections: DriveConnection[],
  context: { operation: string; connectionId?: string; driveId?: string; workspaceId?: string },
): void {
  try {
    atomicSaveJson(CONNECTIONS_FILE, connections);
  } catch (err) {
    log.error(
      {
        event: "drive_connection_save_failed",
        outcome: "drive_connection_change_not_persisted",
        err,
        filePath: CONNECTIONS_FILE,
        ...context,
      },
      "failed to save drive connection change",
    );
    throw err;
  }
}

export function createDrive(name: string, description?: string): Drive {
  const drive: Drive = {
    id: crypto.randomUUID(),
    name: validateDriveName(name),
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
    drive.name = validateDriveName(patch.name);
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
    saveConnections(connections, {
      operation: "update_connection_handles",
      connectionId: existing.id,
      driveId,
      workspaceId,
    });
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
  saveConnections(connections, {
    operation: "connect_drive",
    connectionId: connection.id,
    driveId,
    workspaceId,
  });
  return connection;
}

export function disconnectDrive(connectionId: string): boolean {
  const connections = listConnections();
  const connection = connections.find((candidate) => candidate.id === connectionId);
  const next = connections.filter((c) => c.id !== connectionId);
  if (next.length === connections.length) return false;
  saveConnections(next, {
    operation: "disconnect_drive",
    connectionId,
    driveId: connection?.driveId,
    workspaceId: connection?.workspaceId,
  });
  return true;
}

/** Remove all drive connections for a deleted workspace. */
export function disconnectWorkspace(workspaceId: string): void {
  const connections = listConnections();
  const next = connections.filter((c) => c.workspaceId !== workspaceId);
  if (next.length !== connections.length) {
    saveConnections(next, { operation: "disconnect_workspace", workspaceId });
  }
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
