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
import { requireDirPath, requireEntryPath, resolveHostPath } from "@/lib/operations/files/paths";
import { logFileRouteError, type FileBackend } from "./backend";

interface MoveBody {
  /** Wire-space relative paths, already validated by the caller. */
  sourcePath: string;
  destinationDirectory: string;
}

interface MoveFailure {
  error: string;
  status: number;
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
    return { error: "Symbolic links cannot be moved", status: 400 };
  }

  const destinationDirectory = await resolveHostPath(be.dir, body.destinationDirectory, "destinationDirectory");
  if (!(await fs.stat(destinationDirectory)).isDirectory()) {
    return { error: "Destination must be a directory", status: 400 };
  }

  const sourceStat = await fs.stat(source);
  if (
    sourceStat.isDirectory() &&
    (destinationDirectory === source || destinationDirectory.startsWith(source + path.sep))
  ) {
    return { error: "Cannot move a folder into itself", status: 400 };
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
          error: `An item named ${path.basename(target.destination)} already exists in that folder`,
          status: 409,
        };
      }

      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "EACCES" && code !== "EPERM") throw err;
      return { error: "Source or destination directory is not writable", status: 400 };
    }
    return outcome;
  } catch (err) {
    logFileRouteError(log, err, { sourcePath, destinationDirectory }, "PATCH file move failed");
    return { error: err instanceof Error ? err.message : "Unknown error", status: 400 };
  }
}

/** Move one or more root items into one directory, stopping at the first failed item. */
export async function moveFileContent(req: Request, be: FileBackend): Promise<Response> {
  let parsedBody: unknown;
  try {
    parsedBody = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (!parsedBody || typeof parsedBody !== "object" || Array.isArray(parsedBody)) {
    return NextResponse.json({ error: "JSON body must be an object" }, { status: 400 });
  }

  const candidate = parsedBody as Record<string, unknown>;
  const rawSourcePaths = candidate.sourcePaths;
  if (!Array.isArray(rawSourcePaths) || rawSourcePaths.length === 0) {
    return NextResponse.json({ error: "sourcePaths must be a non-empty array of paths" }, { status: 400 });
  }

  // Every path is validated up front rather than per item, so a batch containing one unsayable path is
  // refused whole instead of moving the items before it and then stopping.
  let sourcePaths: string[];
  let destinationDirectory: string;
  try {
    sourcePaths = rawSourcePaths.map((p) => requireEntryPath(p, "sourcePaths"));
    // null is the client's way of naming the root, and stays so; "" is its wire-space equivalent.
    destinationDirectory = requireDirPath(candidate.destinationDirectory ?? null, "destinationDirectory");
  } catch (err) {
    const message = err instanceof Error ? err.message : "Invalid path";
    return NextResponse.json({ error: message, results: [] }, { status: 400 });
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

  const status = failure && results.length === 0 ? failure.status : 200;
  return NextResponse.json(
    {
      ok: failure === null,
      results: results.map(({ sourcePath, path: destination, unchanged }) => ({
        sourcePath,
        path: destination,
        unchanged,
      })),
      ...(failure ? { error: failure.error, failedSourcePath } : {}),
    },
    { status },
  );
}
