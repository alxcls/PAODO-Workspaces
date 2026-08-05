import type pino from "pino";
import { AppError } from "@/lib/errors/appError";
import type { FileWriteHooks } from "@/lib/operations/files/content";

/**
 * Log a file-route failure only when the system is at fault.
 *
 * These routes funnel every failure into one catch, which used to log all of them at warn. Two kinds
 * are the caller's, not ours, and both already surface as a 4xx the client is shown:
 *
 * - An AppError. By definition an expected, explained failure: a path that is not allowed, a file
 *   that isn't there, a save that lost a race to a move. This covers the path-containment case, which
 *   looks like probing but is reached by a normal click — the file tree lists a symlink as an ordinary
 *   row, and resolveContained refuses it once the boundary is resolved.
 * - A bare ENOENT, for the same reason a NOT_FOUND is not worth a line: a stale tab pointing at a
 *   file another window deleted.
 *
 * Everything else — EACCES, EIO, a full disk — is a genuine system fault and gets logged.
 */
export function logFileRouteError(log: pino.Logger, err: unknown, fields: Record<string, unknown>, msg: string): void {
  if (err instanceof AppError) return;
  if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
  log.warn({ err, ...fields }, msg);
}

/**
 * Storage and mutation hooks shared by the workspace and drive file endpoints.
 *
 * `dir` is the host directory the wire-space relative paths resolve against, and it is the only place
 * the host layout appears — nothing derived from it reaches a response. See lib/files/relpath.ts.
 */
export interface FileBackend extends FileWriteHooks {
  dir: string;
  logContext: Record<string, unknown>;
}
