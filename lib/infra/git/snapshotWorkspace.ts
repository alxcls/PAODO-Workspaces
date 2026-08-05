// Shared fire-and-forget snapshot helper for user-driven file changes (save/delete/upload).
// Takes the versioning service as an argument rather than importing services.ts, so this stays
// out of the services import graph and cycle-free.
import type { IWorkspaceSnapshotWriter } from "../interfaces";
import { createLogger } from "../logger";

const log = createLogger("api");

// Snapshot the workspace after a user-driven file change so it shows up in version history, just
// like an agent run does. Fire-and-forget: a versioning failure must never fail the user's action.
// commitResult force-stages everything and skips itself if nothing actually changed.
export async function snapshotWorkspace(
  versioning: IWorkspaceSnapshotWriter,
  ws: { id: string; dir: string },
  label: string,
): Promise<void> {
  try {
    await versioning.commitResult(ws.id, ws.dir, label);
  } catch (err) {
    log.warn({ err, workspaceId: ws.id }, "versioning snapshot failed");
  }
}

// A folder upload arrives as one request per file, and commitResult force-stages the whole tree on
// every call — so snapshotting per request would run thousands of `git add -A` passes over the same
// directory and dominate the upload's cost. Two seconds of quiet is long enough to bridge the gap
// between files in a burst and short enough that history still updates while the user watches.
const COALESCE_MS = 2_000;

const pending = new Map<string, { timer: NodeJS.Timeout; changes: number; firstChange: string }>();

/**
 * Collapse a burst of file changes into the single snapshot the user actually wants. Each call
 * restarts the timer, so only the quiet period at the end of the burst commits. `label` receives the
 * number of changes coalesced and the name from the first one, letting a lone change keep a specific
 * message ("uploaded notes.md") while a burst gets a summary ("uploaded 2317 files").
 *
 * Fire-and-forget like snapshotWorkspace, and deliberately unref'd: a pending snapshot must never
 * hold the process open at shutdown. A snapshot lost that way is not a data loss — commitResult
 * force-stages everything, so the next one picks up whatever this one would have committed.
 */
export function snapshotWorkspaceCoalesced(
  versioning: IWorkspaceSnapshotWriter,
  ws: { id: string; dir: string },
  change: string,
  label: (changes: number, firstChange: string) => string,
): void {
  const existing = pending.get(ws.id);
  if (existing) clearTimeout(existing.timer);

  const changes = (existing?.changes ?? 0) + 1;
  const firstChange = existing?.firstChange ?? change;
  const timer = setTimeout(() => {
    pending.delete(ws.id);
    void snapshotWorkspace(versioning, ws, label(changes, firstChange));
  }, COALESCE_MS);
  timer.unref();

  pending.set(ws.id, { timer, changes, firstChange });
}
