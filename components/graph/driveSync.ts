// The drive half of a save: delete the drives queued for removal, then reconcile drive→workspace
// links against what the server confirmed. Sequential — a link racing its drive's deletion resurrects it.
import type { Edge, Node } from "@xyflow/react";
import { createDriveConnection, deleteDrive, deleteDriveConnection, type DriveConnectionItem } from "./graphApi";
import { normalizeWorkspaceIncomingHandle } from "./handles";
import { isDriveEdge, nodeData } from "./types";

interface DriveSyncInput {
  edges: Edge[];
  /** Server-confirmed links, keyed by connection id; updated in place as the sync progresses. */
  saved: Map<string, DriveConnectionItem>;
  pendingDeletes: Node[];
  onDriveDeleted(driveId: string): void;
}

/** Ids the canvas must adopt: a link drawn locally carries a temporary id until the server names it. */
export type RenamedEdges = Map<string, string>;

export async function syncDrives({
  edges,
  saved,
  pendingDeletes,
  onDriveDeleted,
}: DriveSyncInput): Promise<RenamedEdges> {
  for (const drive of pendingDeletes) {
    await deleteDrive(drive.id, nodeData(drive.data).label);
    for (const [id, connection] of saved) {
      if (connection.driveId === drive.id) saved.delete(id);
    }
    onDriveDeleted(drive.id);
  }

  const isSaved = (edge: Edge) => {
    const connection = saved.get(edge.id);
    return (
      !!connection &&
      connection.sourceHandle === edge.sourceHandle &&
      normalizeWorkspaceIncomingHandle(connection.targetHandle) === edge.targetHandle
    );
  };

  const driveEdges = edges.filter(isDriveEdge);
  const kept = new Set(driveEdges.filter(isSaved).map((edge) => edge.id));
  for (const connectionId of [...saved.keys()].filter((id) => !kept.has(id))) {
    await deleteDriveConnection(connectionId);
    saved.delete(connectionId);
  }

  const renamed: RenamedEdges = new Map();
  for (const edge of driveEdges.filter((candidate) => !isSaved(candidate))) {
    const connection = await createDriveConnection({
      driveId: edge.source,
      workspaceId: edge.target,
      sourceHandle: edge.sourceHandle,
      targetHandle: edge.targetHandle,
    });
    saved.set(connection.id, connection);
    renamed.set(edge.id, connection.id);
  }
  return renamed;
}
