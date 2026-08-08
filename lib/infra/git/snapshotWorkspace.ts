// Shared fire-and-forget snapshot helper for user-driven file changes (save/delete/upload).
// Takes the versioning service as an argument rather than importing services.ts, so this stays
// out of the services import graph and cycle-free.
import type { IWorkspaceSnapshotWriter } from "../interfaces";
import { createLogger } from "../logger";

const log = createLogger("api");

export interface SnapshotResult {
  sha: string;
  changed: boolean;
}

/**
 * Awaited snapshot for a caller whose response promises a durable revision. Unlike the UI helper
 * below, failures propagate: a transfer receipt must never claim it created a restore point when it
 * did not.
 */
export function snapshotWorkspaceStrict(
  versioning: IWorkspaceSnapshotWriter,
  ws: { id: string; dir: string },
  label: string,
): Promise<SnapshotResult> {
  return versioning.commitResult(ws.id, ws.dir, label);
}

// Snapshot the workspace after a user-driven file change so it shows up in version history, just
// like an agent run does. Fire-and-forget: a versioning failure must never fail the user's action.
// commitResult force-stages everything and skips itself if nothing actually changed.
export async function snapshotWorkspace(
  versioning: IWorkspaceSnapshotWriter,
  ws: { id: string; dir: string },
  label: string,
): Promise<void> {
  try {
    await snapshotWorkspaceStrict(versioning, ws, label);
  } catch (err) {
    log.warn({ err, workspaceId: ws.id }, "versioning snapshot failed");
  }
}

/**
 * Strict counterpart used immediately before a batch transfer. It separates a pending browser
 * upload burst from the transfer that follows and refuses to hide a failed pre-transfer snapshot.
 */
export async function flushSnapshotBurstStrict(
  versioning: IWorkspaceSnapshotWriter,
  ws: { id: string; dir: string },
): Promise<SnapshotResult | null> {
  const burst = pending.get(ws.id);
  if (!burst) return null;
  clearTimeout(burst.timer);
  pending.delete(ws.id);
  return snapshotWorkspaceStrict(versioning, ws, burst.label(burst.changes, burst.firstChange));
}

// A folder upload arrives as one request per file, and commitResult force-stages the whole tree on
// every call — so snapshotting per request would run thousands of `git add -A` passes over the same
// directory and dominate the upload's cost. Two seconds of quiet is long enough to bridge the gap
// between files in a burst and short enough that history still updates while the user watches.
const COALESCE_MS = 2_000;

interface Burst {
  timer: NodeJS.Timeout;
  changes: number;
  firstChange: string;
  /** Kept with the burst so a flush produces the same message the timer would have. */
  label: (changes: number, firstChange: string) => string;
}

const pending = new Map<string, Burst>();

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

  pending.set(ws.id, { timer, changes, firstChange, label });
}

/**
 * Commit the workspace's pending burst now, awaited, instead of waiting out the quiet period.
 *
 * The timer above is the right default when nobody has told us the burst is over — a browser folder
 * upload never does. A caller that *knows* it has sent its last file wants two things the timer
 * cannot give it: exactly one commit no matter how long the burst took (a transfer slower than
 * COALESCE_MS between files commits once per gap otherwise), and a commit that has actually happened
 * by the time the request it belongs to returns, so the reply can name the revision the caller can
 * later restore to. Fire-and-forget is fine for a save the user watches land in the panel; it is not
 * fine as the only durability story for a client that exits the moment it gets its response.
 *
 * Returns whether there was anything pending, so a caller can tell "committed your batch" from
 * "nothing had changed" rather than reporting a snapshot it did not take.
 */
export async function flushSnapshotBurst(
  versioning: IWorkspaceSnapshotWriter,
  ws: { id: string; dir: string },
): Promise<boolean> {
  const burst = pending.get(ws.id);
  if (!burst) return false;
  clearTimeout(burst.timer);
  pending.delete(ws.id);
  await snapshotWorkspace(versioning, ws, burst.label(burst.changes, burst.firstChange));
  return true;
}
