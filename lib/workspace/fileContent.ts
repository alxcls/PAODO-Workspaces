// Shared file-content CRUD for the workspace and drive file routes.
// GET classifies a file as text/image/binary (or serves raw bytes); PUT writes text; PATCH moves;
// DELETE removes.
// All paths are validated to stay inside the backend directory via assertInsideWorkspace.
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
  // Called when a direct fs.writeFile fails with EACCES/EPERM (workspace container fallback).
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
    await fs.mkdir(path.dirname(resolved), { recursive: true });
    try {
      await fs.writeFile(resolved, body.content, "utf-8");
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
 * resolved target, or a NextResponse to short-circuit the handler (the `lib/api/guards` idiom).
 */
async function resolveMoveTarget(be: FileBackend, body: MoveBody): Promise<MoveTarget | NextResponse> {
  const lexicalSource = lexicalPath(be, body.sourcePath);
  const source = await assertInsideWorkspace(be.dir, lexicalSource);
  const workspaceRoot = await fs.realpath(be.dir);
  if (source === workspaceRoot) {
    return NextResponse.json({ error: "Cannot move the workspace root" }, { status: 400 });
  }

  // Moving a symlink by its resolved target would be surprising and moving it lexically would
  // need a separate containment model. The file tree does not expose symlink directories, so
  // reject the uncommon leaf-symlink case explicitly instead of moving the wrong object.
  if ((await fs.lstat(lexicalSource)).isSymbolicLink()) {
    return NextResponse.json({ error: "Symbolic links cannot be moved" }, { status: 400 });
  }

  const lexicalDirectory = body.destinationDirectory
    ? lexicalPath(be, body.destinationDirectory)
    : be.dir;
  const destinationDirectory = await assertInsideWorkspace(be.dir, lexicalDirectory);
  if (!(await fs.stat(destinationDirectory)).isDirectory()) {
    return NextResponse.json({ error: "Destination must be a directory" }, { status: 400 });
  }

  const sourceStat = await fs.stat(source);
  if (
    sourceStat.isDirectory()
    && (destinationDirectory === source || destinationDirectory.startsWith(source + path.sep))
  ) {
    return NextResponse.json({ error: "Cannot move a folder into itself" }, { status: 400 });
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
  if (typeof candidate.sourcePath !== "string" || candidate.sourcePath.length === 0) {
    return NextResponse.json({ error: "sourcePath required" }, { status: 400 });
  }
  if (
    candidate.destinationDirectory !== undefined
    && candidate.destinationDirectory !== null
    && (typeof candidate.destinationDirectory !== "string" || candidate.destinationDirectory.length === 0)
  ) {
    return NextResponse.json({ error: "destinationDirectory must be a non-empty string or null" }, { status: 400 });
  }
  const body: MoveBody = {
    sourcePath: candidate.sourcePath,
    destinationDirectory: candidate.destinationDirectory as string | null | undefined,
  };

  const log = createLogger("api").child(be.logContext);
  try {
    const target = await resolveMoveTarget(be, {
      sourcePath: body.sourcePath,
      destinationDirectory: body.destinationDirectory,
    });
    if (target instanceof NextResponse) return target;
    if (target.unchanged) {
      return NextResponse.json({ ok: true, path: target.clientDestination, unchanged: true });
    }

    try {
      await moveWithoutOverwrite(target);
    } catch (err) {
      if (err instanceof DestinationConflictError) {
        return NextResponse.json(
          { error: `An item named ${path.basename(target.destination)} already exists in that folder` },
          { status: 409 },
        );
      }

      // Legacy root-owned files (see the workspace backend's writeFallback) may not be movable by
      // the host process. Unlike a write, a move has no container fallback, so report it plainly
      // rather than leaking the raw errno string.
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "EACCES" && code !== "EPERM") throw err;
      return NextResponse.json(
        { error: "Source or destination directory is not writable" },
        { status: 400 },
      );
    }

    await be.afterWrite?.(`moved ${path.basename(target.source)} to ${target.destinationLabel}`);
    return NextResponse.json({ ok: true, path: target.clientDestination });
  } catch (err) {
    log.warn({ err, sourcePath: body.sourcePath, destinationDirectory: body.destinationDirectory }, "PATCH file move failed");
    const msg = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: msg }, { status: 400 });
  }
}
