import type { FileWriteHooks } from "@/lib/operations/files/content";

/**
 * Storage and mutation hooks shared by the workspace and drive file endpoints.
 *
 * `dir` is the host directory the wire-space relative paths resolve against, and it is the only place
 * the host layout appears — nothing derived from it reaches a response. See lib/files/relpath.ts.
 *
 * There used to be a logFileRouteError helper here, whose job was to decide which failures were the
 * caller's and not worth a log line. That decision now falls out of the type: an expected failure is an
 * AppError (lib/operations/files/errors.ts classifies every errno with a public meaning), and anything
 * that is not one is unexpected by definition and gets logged with a literal event before an opaque
 * 500 — the convention lib/api/errorResponse.ts describes.
 */
export interface FileBackend extends FileWriteHooks {
  dir: string;
  logContext: Record<string, unknown>;
}
