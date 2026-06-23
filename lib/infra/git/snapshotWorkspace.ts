// Shared fire-and-forget snapshot helper for user-driven file changes (save/delete/upload).
// Takes the versioning service as an argument rather than importing services.ts, so this stays
// out of the services import graph and cycle-free.
import type { IWorkspaceVersioning } from "../interfaces";
import { createLogger } from "../logger";

const log = createLogger("api");

// Snapshot the workspace after a user-driven file change so it shows up in version history, just
// like an agent run does. Fire-and-forget: a versioning failure must never fail the user's action.
// commitResult force-stages everything and skips itself if nothing actually changed.
export async function snapshotWorkspace(
  versioning: IWorkspaceVersioning,
  ws: { id: string; dir: string },
  label: string,
): Promise<void> {
  try {
    await versioning.commitResult(ws.id, ws.dir, label);
  } catch (err) {
    log.warn({ err, workspaceId: ws.id }, "versioning snapshot failed");
  }
}
