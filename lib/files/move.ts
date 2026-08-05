// Server-side file move policy shared by workspace and drive routes.
// This module owns validation, containment-safe target resolution, no-clobber filesystem moves,
// batch outcomes, and the single post-move snapshot. General content CRUD lives in
// lib/operations/files/content.ts, behind lib/api/fileContentRoutes.ts.
//
// Paths in and out are workspace-relative (lib/files/relpath.ts); `destinationDirectory: null` remains
// the client's way of naming the root.

import { NextResponse } from "next/server";
import fs from "fs/promises";
import path from "path";
import { createLogger } from "@/lib/infra/logger";
import { AppError, type AppErrorCode } from "@/lib/errors/appError";
import { errorResponse, readJsonObject } from "@/lib/api/errorResponse";
import { fileSystemAppError } from "@/lib/operations/files/errors";
import { requireDirPath, requireEntryPath, resolveHostPath } from "@/lib/operations/files/paths";
import type { FileBackend } from "./backend";

interface MoveBody {
  /** Wire-space relative paths, already validated by the caller. */
  sourcePath: string;
  destinationDirectory: string;
}

/**
 * Why one item of a batch could not move. It carries a code rather than a status: a batch that moved
 * some of its items answers 200 with the failure inside it, so the transport status is not the place
 * the reason can live.
 */
interface MoveFailure {
  code: AppErrorCode;
  error: string;
}

interface MoveOutcome {
  sourcePath: string;
  /** Lexical destination, in the path space the file tree serves. */
  path: string;
  unchanged: boolean;
  /** Internal fields used to compose the batch snapshot message. */
  name: string;
  destinationLabel: string;
}

function isFailure<T extends object>(result: T | MoveFailure): result is MoveFailure {
  return "error" in result;
}

interface MoveTarget {
  /** Real host paths used by filesystem operations. */
  source: string;
  destination: string;
  /** Wire-space relative path returned to the client. */
  clientDestination: string;
  unchanged: boolean;
  destinationLabel: string;
  sourceStat: Awaited<ReturnType<typeof fs.stat>>;
}

class DestinationConflictError extends Error {}

async function resolveMoveTarget(be: FileBackend, body: MoveBody): Promise<MoveTarget | MoveFailure> {
  // Containment first, so an out-of-tree path is refused as such before anything else looks at it.
  // The root cannot appear here at all: requireEntryPath refuses "" for exactly this reason.
  const source = await resolveHostPath(be.dir, body.sourcePath, "sourcePaths");

  // Resolving a symlink and then moving its target would move a different object than the tree row.
  // This has to lstat the *lexical* path: resolveHostPath returns the realpath, which is the target
  // rather than the link, so by then the symlink is no longer visible.
  if ((await fs.lstat(path.join(be.dir, body.sourcePath))).isSymbolicLink()) {
    return { code: "INVALID_REQUEST", error: "Symbolic links cannot be moved" };
  }

  const destinationDirectory = await resolveHostPath(be.dir, body.destinationDirectory, "destinationDirectory");
  if (!(await fs.stat(destinationDirectory)).isDirectory()) {
    return { code: "INVALID_REQUEST", error: "Destination must be a directory" };
  }

  const sourceStat = await fs.stat(source);
  if (
    sourceStat.isDirectory() &&
    (destinationDirectory === source || destinationDirectory.startsWith(source + path.sep))
  ) {
    return { code: "INVALID_REQUEST", error: "Cannot move a folder into itself" };
  }

  const name = path.basename(body.sourcePath);
  const destination = path.join(destinationDirectory, name);
  return {
    source,
    destination,
    clientDestination: body.destinationDirectory === "" ? name : `${body.destinationDirectory}/${name}`,
    unchanged: destination === source,
    destinationLabel: body.destinationDirectory || "workspace root",
    sourceStat,
  };
}

/** Move one item without ever replacing an existing destination. */
async function moveWithoutOverwrite(target: MoveTarget): Promise<void> {
  if (!target.sourceStat.isDirectory()) {
    try {
      await fs.link(target.source, target.destination);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") {
        throw new DestinationConflictError();
      }
      throw err;
    }

    try {
      await fs.unlink(target.source);
    } catch (err) {
      // Both names reference the same inode, so this rollback cannot remove another writer's file.
      await fs.unlink(target.destination).catch(() => undefined);
      throw err;
    }
    return;
  }

  // Reserve the directory name so rename cannot silently replace an empty directory.
  try {
    await fs.mkdir(target.destination);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") {
      throw new DestinationConflictError();
    }
    throw err;
  }

  try {
    await fs.rename(target.source, target.destination);
  } catch (err) {
    // Only remove our still-empty reservation. A populated reservation is deliberately retained.
    await fs.rmdir(target.destination).catch(() => undefined);
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EEXIST" || code === "ENOTEMPTY") throw new DestinationConflictError();
    throw err;
  }
}

async function moveOne(
  be: FileBackend,
  sourcePath: string,
  destinationDirectory: string,
  log: ReturnType<typeof createLogger>,
): Promise<MoveOutcome | MoveFailure> {
  try {
    const target = await resolveMoveTarget(be, { sourcePath, destinationDirectory });
    if (isFailure(target)) return target;

    const outcome: MoveOutcome = {
      sourcePath,
      path: target.clientDestination,
      unchanged: target.unchanged,
      name: path.basename(target.source),
      destinationLabel: target.destinationLabel,
    };
    if (target.unchanged) return outcome;

    try {
      await moveWithoutOverwrite(target);
    } catch (err) {
      if (err instanceof DestinationConflictError) {
        return {
          code: "CONFLICT",
          error: `An item named ${path.basename(target.destination)} already exists in that folder`,
        };
      }

      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "EACCES" && code !== "EPERM") throw err;
      return { code: "FILE_NOT_WRITABLE", error: "Source or destination directory is not writable" };
    }
    return outcome;
  } catch (err) {
    // The expected failures — a path the caller may not say, an errno with a public meaning — arrive
    // as AppError and keep their own code. Anything else is ours, so it is logged once here and the
    // item reports an opaque INTERNAL_ERROR rather than relaying a message libuv wrote the host path
    // into.
    const known = err instanceof AppError ? err : fileSystemAppError(err, sourcePath);
    if (known) return { code: known.code, error: known.message };
    log.error(
      { event: "file_move_failed", outcome: "item_not_moved", err, sourcePath, destinationDirectory },
      "unclassified file move failure",
    );
    return { code: "INTERNAL_ERROR", error: "The move failed" };
  }
}

/** Move one or more root items into one directory, stopping at the first failed item. */
export async function moveFileContent(req: Request, be: FileBackend): Promise<Response> {
  const candidate = await readJsonObject(req);
  if (candidate instanceof NextResponse) return candidate;

  const rawSourcePaths = candidate.sourcePaths;
  if (!Array.isArray(rawSourcePaths) || rawSourcePaths.length === 0) {
    return errorResponse("INVALID_REQUEST", "sourcePaths must be a non-empty array of paths", {
      request: req,
      details: { field: "sourcePaths" },
    });
  }

  // Every path is validated up front rather than per item, so a batch containing one unsayable path is
  // refused whole instead of moving the items before it and then stopping. `results: []` travels with
  // the refusal because the client distinguishes a rejected batch from a malformed request by its
  // presence.
  let sourcePaths: string[];
  let destinationDirectory: string;
  try {
    sourcePaths = rawSourcePaths.map((p) => requireEntryPath(p, "sourcePaths"));
    // null is the client's way of naming the root, and stays so; "" is its wire-space equivalent.
    destinationDirectory = requireDirPath(candidate.destinationDirectory ?? null, "destinationDirectory");
  } catch (err) {
    if (!(err instanceof AppError)) throw err;
    return errorResponse(err.code, err.message, { request: req, details: err.details, extra: { results: [] } });
  }

  const log = createLogger("api").child(be.logContext);
  const results: MoveOutcome[] = [];
  let failure: MoveFailure | null = null;
  let failedSourcePath: string | null = null;

  for (const sourcePath of sourcePaths) {
    const result = await moveOne(be, sourcePath, destinationDirectory, log);
    if (isFailure(result)) {
      failure = result;
      failedSourcePath = sourcePath;
      break;
    }
    results.push(result);
  }

  const moved = results.filter((result) => !result.unchanged);
  if (moved.length > 0) {
    const message =
      moved.length === 1
        ? `moved ${moved[0].name} to ${moved[0].destinationLabel}`
        : `moved ${moved.length} items to ${moved[0].destinationLabel}`;
    try {
      await be.afterWrite?.(message);
    } catch (err) {
      // The disk move already succeeded, so a snapshot failure must not invalidate the response.
      log.warn({ err }, "move snapshot failed");
    }
  }

  // A batch that moved nothing is a plain failure and takes the status its code maps to. One that moved
  // some of its items is a 200 carrying both halves — the transport succeeded, and the client needs the
  // per-item results to reconcile its tree whatever else went wrong.
  if (failure && results.length === 0) {
    return errorResponse(failure.code, failure.error, {
      request: req,
      extra: { results: [], failedSourcePath },
    });
  }
  return NextResponse.json({
    ok: failure === null,
    results: results.map(({ sourcePath, path: destination, unchanged }) => ({
      sourcePath,
      path: destination,
      unchanged,
    })),
    ...(failure ? { code: failure.code, error: failure.error, failedSourcePath } : {}),
  });
}
