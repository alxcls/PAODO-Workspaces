// Shared file-content CRUD for the workspace and drive file routes.
// GET classifies a file as text/image/binary (or serves raw bytes); PUT writes text; PATCH moves a
// batch of items into one directory (see moveFileContent); DELETE removes.
// All paths are validated to stay inside the backend directory via assertInsideWorkspace.
//
// PUT updates an existing file and never creates one: it opens without O_CREAT so that a save
// racing a move fails with ENOENT (surfaced as 409) instead of resurrecting the old path. Any
// future caller that needs create-on-save must add it deliberately, not by relaxing the open flags.
//
// The two callers differ only in their FileBackend: a workspace supplies a container `writeFallback`
// (for legacy root-owned files) and an `afterWrite` git snapshot; a drive is passive host storage and
// supplies neither. Everything else — classification, containment, raw serving — is identical here.
//
// Two path spaces meet in this module and must not be confused. `assertInsideWorkspace` returns a
// REALPATH, which every fs call here uses. The browser, however, only ever knows the LEXICAL paths
// buildTree (fileTree.ts) composed from `be.dir` — so any path handed back to a client is composed
// from `be.dir` too. The two coincide only while `be.dir` contains no symlink, which is true in
// production but not on macOS dev (/var → /private/var).
import { NextResponse } from "next/server";
import fs from "fs/promises";
import path from "path";
import { createLogger } from "@/lib/infra/logger";
import { assertInsideWorkspace } from "@/lib/infra/workspaceContainment";

/** A client-supplied path (absolute, as the file tree serves them, or relative) in `be.dir` space. */
function lexicalPath(be: FileBackend, p: string): string {
  return path.isAbsolute(p) ? p : path.join(be.dir, p);
}

export interface FileBackend {
  dir: string;
  logContext: Record<string, unknown>;
  // Called when a direct existing-file overwrite fails with EACCES/EPERM (workspace container
  // fallback). It must not create a missing path: a concurrent move may already have removed it.
  writeFallback?: (resolved: string, content: string) => Promise<void>;
  // Called after a successful mutation (workspace git snapshot). `message` describes the change.
  afterWrite?: (message: string) => Promise<void>;
}

type FileClass =
  | { type: "image"; mimeType: string }
  | { type: "text"; content: string }
  | { type: "binary" };

async function classifyBuffer(buf: Buffer): Promise<FileClass> {
  const { fileTypeFromBuffer } = await import("file-type");
  const result = await fileTypeFromBuffer(buf);

  if (result) {
    if (result.mime.startsWith("image/")) return { type: "image", mimeType: result.mime };
    return { type: "binary" };
  }

  // No magic bytes detected — try UTF-8 decode
  try {
    const content = new TextDecoder("utf-8", { fatal: true }).decode(buf);
    // SVG is text-based XML — classify as image so the viewer can render it
    const trimmed = content.trimStart();
    if (trimmed.startsWith("<svg") || (trimmed.startsWith("<?xml") && content.includes("<svg")))
      return { type: "image", mimeType: "image/svg+xml" };
    return { type: "text", content };
  } catch {
    return { type: "binary" };
  }
}

export async function getFileContent(req: Request, be: FileBackend): Promise<Response> {
  const { searchParams } = new URL(req.url);
  const filePath = searchParams.get("path");
  if (!filePath) return NextResponse.json({ error: "path required" }, { status: 400 });

  const log = createLogger("api").child(be.logContext);
  try {
    const resolved = await assertInsideWorkspace(be.dir, filePath);
    const buf = await fs.readFile(resolved);
    const classified = await classifyBuffer(buf);

    // ?raw=1 — serve raw bytes for <img src> and download links
    if (searchParams.get("raw") === "1") {
      const mime = classified.type === "image" ? classified.mimeType : "application/octet-stream";
      const isDownload = searchParams.get("download") === "1";
      return new Response(buf, {
        headers: {
          "Content-Type": mime,
          ...(isDownload ? { "Content-Disposition": `attachment; filename="${path.basename(resolved)}"` } : {}),
        },
      });
    }

    if (classified.type === "text") return NextResponse.json({ type: "text", content: classified.content });
    if (classified.type === "image") return NextResponse.json({ type: "image" });
    return NextResponse.json({ type: "binary" });
  } catch (err) {
    log.warn({ err, filePath }, "GET file failed");
    const msg = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: msg }, { status: 400 });
  }
}

export async function putFileContent(req: Request, be: FileBackend): Promise<Response> {
  const body = (await req.json()) as { path?: string; content?: string };
  if (!body.path || body.content === undefined) {
    return NextResponse.json({ error: "path and content required" }, { status: 400 });
  }

  const log = createLogger("api").child(be.logContext);
  try {
    const resolved = await assertInsideWorkspace(be.dir, lexicalPath(be, body.path));
    try {
      // Open without O_CREAT before truncating. If a move won the race, this fails instead of
      // recreating the old path; if the open won, the descriptor follows the same inode through
      // the move and the content lands at its new name.
      const handle = await fs.open(resolved, "r+");
      try {
        await handle.truncate(0);
        await handle.writeFile(body.content, "utf-8");
      } finally {
        await handle.close();
      }
    } catch (writeErr) {
      const code = (writeErr as NodeJS.ErrnoException).code;
      if ((code === "EACCES" || code === "EPERM") && be.writeFallback) {
        await be.writeFallback(resolved, body.content);
      } else {
        throw writeErr;
      }
    }
    await be.afterWrite?.(`saved ${path.basename(resolved)}`);
    return NextResponse.json({ ok: true });
  } catch (err) {
    log.warn({ err, path: body.path }, "PUT file failed");
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return NextResponse.json(
        { error: "File was moved or deleted before it could be saved" },
        { status: 409 },
      );
    }
    const msg = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: msg }, { status: 400 });
  }
}

export async function deleteFileContent(req: Request, be: FileBackend): Promise<Response> {
  const { searchParams } = new URL(req.url);
  const filePath = searchParams.get("path");
  if (!filePath) return NextResponse.json({ error: "path required" }, { status: 400 });

  const log = createLogger("api").child(be.logContext);
  try {
    const resolved = await assertInsideWorkspace(be.dir, filePath);
    await fs.access(path.dirname(resolved), fs.constants.W_OK).catch(() => {
      throw new Error("Directory is not writable");
    });
    const stat = await fs.stat(resolved);
    if (stat.isDirectory()) {
      await fs.rm(resolved, { recursive: true });
    } else {
      await fs.unlink(resolved);
    }
    await be.afterWrite?.(`deleted ${path.basename(resolved)}`);
    return NextResponse.json({ ok: true });
  } catch (err) {
    log.warn({ err, filePath }, "DELETE file failed");
    const msg = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: msg }, { status: 400 });
  }
}

interface MoveBody {
  sourcePath: string;
  destinationDirectory?: string | null;
}

/** Why one item cannot move, and the status it would carry as the whole request's outcome. */
interface MoveFailure {
  error: string;
  status: number;
}

/** One item's result, as the client needs it: where it now lives, and whether it actually moved. */
interface MoveOutcome {
  sourcePath: string;
  /** Lexical destination, in the path space the file tree serves. */
  path: string;
  unchanged: boolean;
  /** Internal — the batch's snapshot message is composed from these, never sent to the client. */
  name: string;
  destinationLabel: string;
}

function isFailure<T extends object>(result: T | MoveFailure): result is MoveFailure {
  return "error" in result;
}

interface MoveTarget {
  /** Realpath of the item being moved — what fs.rename acts on. */
  source: string;
  /** Realpath the item will occupy. */
  destination: string;
  /** The destination in the lexical space the file tree serves, for the response body. */
  clientDestination: string;
  /** The item is already in the destination directory; renaming it would be a no-op. */
  unchanged: boolean;
  /** Directory label relative to the workspace root, for the git snapshot message. */
  destinationLabel: string;
  /** Source metadata captured during validation, used to choose a no-clobber move strategy. */
  sourceStat: Awaited<ReturnType<typeof fs.stat>>;
}

class DestinationConflictError extends Error {}

/**
 * Validate a move request, resolving both ends and every rule that can reject one: containment,
 * the workspace root, symlinks, non-directory destinations, and folder-into-itself. Returns the
 * resolved target, or the reason it cannot move — a plain value rather than a response, so a batch
 * can attribute the failure to its item and still report the moves that already landed.
 */
async function resolveMoveTarget(be: FileBackend, body: MoveBody): Promise<MoveTarget | MoveFailure> {
  const lexicalSource = lexicalPath(be, body.sourcePath);
  const source = await assertInsideWorkspace(be.dir, lexicalSource);
  const workspaceRoot = await fs.realpath(be.dir);
  if (source === workspaceRoot) {
    return { error: "Cannot move the workspace root", status: 400 };
  }

  // Moving a symlink by its resolved target would be surprising and moving it lexically would
  // need a separate containment model. The file tree does not expose symlink directories, so
  // reject the uncommon leaf-symlink case explicitly instead of moving the wrong object.
  if ((await fs.lstat(lexicalSource)).isSymbolicLink()) {
    return { error: "Symbolic links cannot be moved", status: 400 };
  }

  const lexicalDirectory = body.destinationDirectory
    ? lexicalPath(be, body.destinationDirectory)
    : be.dir;
  const destinationDirectory = await assertInsideWorkspace(be.dir, lexicalDirectory);
  if (!(await fs.stat(destinationDirectory)).isDirectory()) {
    return { error: "Destination must be a directory", status: 400 };
  }

  const sourceStat = await fs.stat(source);
  if (
    sourceStat.isDirectory()
    && (destinationDirectory === source || destinationDirectory.startsWith(source + path.sep))
  ) {
    return { error: "Cannot move a folder into itself", status: 400 };
  }

  // The leaf is not a symlink (rejected above), so realpath preserved its name.
  const name = path.basename(source);
  const destination = path.join(destinationDirectory, name);
  return {
    source,
    destination,
    clientDestination: path.join(lexicalDirectory, name),
    unchanged: destination === source,
    destinationLabel: path.relative(workspaceRoot, destinationDirectory) || "workspace root",
    sourceStat,
  };
}

/**
 * Move without ever replacing an existing destination.
 *
 * Files use an exclusive hard-link followed by unlinking the source. Directories first reserve the
 * destination name with mkdir, then atomically rename over that empty reservation. If another
 * writer populates the reservation, rename fails and both the original source and new destination
 * are preserved.
 */
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
      // Roll back the link if removing the source fails. Both names reference the same inode, so
      // removing our destination cannot discard a distinct file created by another writer.
      await fs.unlink(target.destination).catch(() => undefined);
      throw err;
    }
    return;
  }

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
    // Only remove our still-empty reservation. If another writer added anything, rmdir fails and
    // deliberately leaves their destination intact.
    await fs.rmdir(target.destination).catch(() => undefined);
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EEXIST" || code === "ENOTEMPTY") throw new DestinationConflictError();
    throw err;
  }
}

/** Resolve and perform one item's move. Never throws: every rejection becomes a MoveFailure. */
async function moveOne(
  be: FileBackend,
  sourcePath: string,
  destinationDirectory: string | null | undefined,
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

      // Legacy root-owned files (see the workspace backend's writeFallback) may not be movable by
      // the host process. Unlike a write, a move has no container fallback, so report it plainly
      // rather than leaking the raw errno string.
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "EACCES" && code !== "EPERM") throw err;
      return { error: "Source or destination directory is not writable", status: 400 };
    }
    return outcome;
  } catch (err) {
    log.warn({ err, sourcePath, destinationDirectory }, "PATCH file move failed");
    return { error: err instanceof Error ? err.message : "Unknown error", status: 400 };
  }
}

/**
 * Move one or more items into a single destination directory.
 *
 * The whole batch is one request and one git snapshot, because the alternative — a request and a
 * snapshot per item — costs orders of magnitude more than the moves themselves (a link+unlink or a
 * rename) and made large selections crawl.
 *
 * Items are moved in order and the batch stops at the first failure rather than pressing on through
 * a tree that is already not what the client thinks it is. Whatever moved before that stays moved
 * and is reported, so the client can reconcile precisely instead of guessing.
 *
 * Callers must send siblings — `collapseToRoots` on the client drops any path travelling with a
 * selected ancestor — so no item can re-path a later one.
 */
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
  const sourcePaths = candidate.sourcePaths;
  if (
    !Array.isArray(sourcePaths)
    || sourcePaths.length === 0
    || !sourcePaths.every((p) => typeof p === "string" && p.length > 0)
  ) {
    return NextResponse.json(
      { error: "sourcePaths must be a non-empty array of paths" },
      { status: 400 },
    );
  }
  if (
    candidate.destinationDirectory !== undefined
    && candidate.destinationDirectory !== null
    && (typeof candidate.destinationDirectory !== "string" || candidate.destinationDirectory.length === 0)
  ) {
    return NextResponse.json({ error: "destinationDirectory must be a non-empty string or null" }, { status: 400 });
  }
  const destinationDirectory = candidate.destinationDirectory as string | null | undefined;

  const log = createLogger("api").child(be.logContext);
  const results: MoveOutcome[] = [];
  let failure: MoveFailure | null = null;
  let failedSourcePath: string | null = null;

  for (const sourcePath of sourcePaths as string[]) {
    const result = await moveOne(be, sourcePath, destinationDirectory, log);
    if (isFailure(result)) {
      failure = result;
      failedSourcePath = sourcePath;
      break;
    }
    results.push(result);
  }

  // One snapshot for the batch, and only if something actually changed on disk — an all-unchanged
  // request is a no-op and must not manufacture an empty commit.
  const moved = results.filter((r) => !r.unchanged);
  if (moved.length > 0) {
    const message = moved.length === 1
      ? `moved ${moved[0].name} to ${moved[0].destinationLabel}`
      : `moved ${moved.length} items to ${moved[0].destinationLabel}`;
    try {
      await be.afterWrite?.(message);
    } catch (err) {
      // The files are already moved; a failed snapshot must not be reported as a failed move, or
      // the client would leave them on screen at paths that no longer exist.
      log.warn({ err }, "move snapshot failed");
    }
  }

  // A request where nothing landed answers with the failure's own status, so a single move still
  // reports 409/400 as it always has. A partial batch is a 200: some of the work is real, and the
  // body carries which items moved and why the rest did not.
  const status = failure && results.length === 0 ? failure.status : 200;
  return NextResponse.json(
    {
      ok: failure === null,
      results: results.map(({ sourcePath, path: destination, unchanged }) =>
        ({ sourcePath, path: destination, unchanged })),
      ...(failure ? { error: failure.error, failedSourcePath } : {}),
    },
    { status },
  );
}
