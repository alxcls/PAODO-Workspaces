import path from "path";
import type pino from "pino";
import { PathContainmentError } from "./assertContained";

/**
 * Log a file-route failure only when the system is at fault.
 *
 * These routes funnel every failure into one catch, which used to log all of them at warn. Two kinds
 * are the user's, not ours, and both already surface as a 4xx the UI shows them:
 *
 * - ENOENT — a stale tab pointing at a file deleted in another window.
 * - A path outside the workspace. This looks like probing, but a normal click reaches it: fileTree
 *   lists symlinks as ordinary files, assertInsideWorkspace resolves them before checking the
 *   boundary, so clicking a symlink the agent created pointing out of the workspace lands here.
 *   Not worth a line when the common cause is a legitimate click.
 *
 * Everything else — EACCES, EIO, a full disk — is a genuine system fault and gets logged.
 */
export function logFileRouteError(log: pino.Logger, err: unknown, fields: Record<string, unknown>, msg: string): void {
  if (err instanceof PathContainmentError) return;
  if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
  log.warn({ err, ...fields }, msg);
}

/** Storage and mutation hooks shared by workspace and drive file endpoints. */
export interface FileBackend {
  dir: string;
  logContext: Record<string, unknown>;
  // Workspace-only fallback for legacy root-owned files. It must never create a missing path.
  writeFallback?: (resolved: string, content: string) => Promise<void>;
  // Workspace git snapshot hook. Drives intentionally omit it.
  afterWrite?: (message: string) => Promise<void>;
}

/** Convert a client path into the lexical path space served by the file tree. */
export function lexicalFilePath(be: FileBackend, filePath: string): string {
  return path.isAbsolute(filePath) ? filePath : path.join(be.dir, filePath);
}
