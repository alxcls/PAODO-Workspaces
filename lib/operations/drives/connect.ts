// Drive↔workspace connection use cases.
//
// The rule these own is referential integrity: a connection names two entities, and it is only
// meaningful while both exist. The store cannot enforce that — it holds drives and connections but
// knows nothing about the workspace registry — so the check has to live above it, and above it used
// to mean "in the route". A dangling connection is not a harmless row: getDrivesForWorkspace and
// resolveDriveDir project connections into what an agent can address by name, and the graph editor
// renders an edge for each one.
//
// Input is validated before either lookup, so a caller that sent nothing at all is told what the
// request needs rather than which of its two absent entities was missed first.
import { AppError, requireNonEmptyString } from "@/lib/errors/appError";
import { connectDrive, disconnectDrive, getDrive, type DriveConnection } from "@/lib/drives/store";
import { getStore } from "@/lib/infra/services";
import { connectionKind } from "@/lib/connections/ids";

export interface ConnectDriveInput {
  driveId?: unknown;
  workspaceId?: unknown;
  /** The graph editor's attachment points, replayed so a saved edge redraws where it was dropped. */
  sourceHandle?: unknown;
  targetHandle?: unknown;
}

export interface DisconnectDriveInput {
  connectionId?: unknown;
}

export interface DisconnectDriveResult {
  deleted: boolean;
}

/** Narrower than the drive store and the workspace store: existence, and the two writes. */
export interface DriveConnectionDeps {
  driveExists(driveId: string): boolean;
  workspaceExists(workspaceId: string): boolean;
  connect: typeof connectDrive;
  disconnect: typeof disconnectDrive;
}

function defaultDeps(): DriveConnectionDeps {
  return {
    driveExists: (driveId) => getDrive(driveId) !== undefined,
    workspaceExists: (workspaceId) => getStore().getWorkspace(workspaceId) !== undefined,
    connect: connectDrive,
    disconnect: disconnectDrive,
  };
}

/** A handle is optional; absent and null both mean "no handle recorded". */
function optionalHandle(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") {
    throw new AppError("INVALID_REQUEST", `${field} must be a string`, { field });
  }
  return value;
}

/**
 * Connect a drive to a workspace, or move an existing link's handles. Reconnecting the same pair is
 * deliberately not an error — the store keeps one link per pair and updates its handles — so the
 * graph editor can save a moved edge without first deleting it.
 */
export function connectDriveToWorkspace(
  input: ConnectDriveInput,
  deps: DriveConnectionDeps = defaultDeps(),
): DriveConnection {
  const driveId = requireNonEmptyString(input.driveId, "driveId");
  const workspaceId = requireNonEmptyString(input.workspaceId, "workspaceId");
  const sourceHandle = optionalHandle(input.sourceHandle, "sourceHandle");
  const targetHandle = optionalHandle(input.targetHandle, "targetHandle");

  if (!deps.driveExists(driveId)) {
    throw new AppError("NOT_FOUND", "drive not found", { field: "driveId" });
  }
  if (!deps.workspaceExists(workspaceId)) {
    throw new AppError("NOT_FOUND", "workspace not found", { field: "workspaceId" });
  }

  return deps.connect(driveId, workspaceId, { sourceHandle, targetHandle });
}

/**
 * Remove one connection. An unknown id reports `deleted: false` rather than raising: the caller
 * asked for a state this leaves established, and the graph editor prunes links it believes are
 * stale, which races with a drive deletion that already dropped them.
 */
export function disconnectDriveFromWorkspace(
  input: DisconnectDriveInput,
  deps: DriveConnectionDeps = defaultDeps(),
): DisconnectDriveResult {
  const connectionId = requireNonEmptyString(input.connectionId, "connectionId");
  // An id from the other graph, or from neither, is refused by name rather than reported as a link
  // that is already gone. The `deleted: false` above answers "this is not connected any more", which
  // is true of every string ever sent — and so tells a caller holding the wrong id nothing at all.
  if (connectionKind(connectionId) !== "link") {
    throw new AppError("INVALID_REQUEST", "connectionId must be a drive link id, which starts with link_", {
      field: "connectionId",
    });
  }
  return { deleted: deps.disconnect(connectionId) };
}
