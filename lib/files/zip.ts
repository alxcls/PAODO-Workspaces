// Shared helpers for the file-download routes (workspace + drive). Both take a list of caller
// selected paths and stream them back as a single ZIP. Two things make this fast for large
// selections: fast DEFLATE (level 1 — a fraction of the CPU of the default level 6 for source
// trees, with similar ratios) and streaming the archive as it's produced rather than buffering the
// whole thing in memory before the first byte ships, so the browser's download starts immediately.
//
// All filesystem access goes through the shared descriptor budget (./fdLimit.ts): a naive
// Promise.all over a large tree opens every file at once and hits EMFILE ("too many open files"),
// which silently drops the unreadable files from the archive. Capping concurrent fds keeps the zip
// complete.
//
// What goes in is the shared ignore contract (./ignore.ts), not "everything under the selected
// paths". The archive is the read side of a file transfer, so it has to answer the question the same
// way the tree and an upload do — a zip that carries node_modules the tree never showed and an upload
// would never send back is the download and the upload disagreeing about what the workspace is.
// A path named EXPLICITLY by the caller is still archived even if the contract would exclude it: that
// is a deliberate selection, not a traversal, and refusing it would leave no way to fetch such a
// directory at all.

import fs from "fs/promises";
import path from "path";
import type JSZip from "jszip";
import { readTransferEntries } from "./entries";
import { openFileLimiter, type Semaphore } from "./fdLimit";

async function addDirToZip(zip: JSZip, sem: Semaphore, dirPath: string, zipPath: string) {
  const entries = await readTransferEntries(dirPath, sem);
  // JSZip only materializes a folder when something is placed inside it, so a directory with no
  // files anywhere beneath it would vanish from the archive. Add an explicit folder entry to keep
  // empty directories (and dirs holding only empty subdirs) present in the download.
  if (entries.length === 0) {
    zip.folder(zipPath);
    return;
  }
  await Promise.all(
    entries.map(async (entry) => {
      const fullPath = path.join(dirPath, entry.name);
      const entryZipPath = path.join(zipPath, entry.name);
      if (entry.isDirectory()) await addDirToZip(zip, sem, fullPath, entryZipPath);
      else zip.file(entryZipPath, await sem.run(() => fs.readFile(fullPath)));
    }),
  );
}

// Add each caller-selected path to the zip, recursing into directories. Paths are validated to stay
// within `baseDir` (anything outside is ignored); unreadable paths are reported via `onSkip` and
// left out rather than aborting the whole archive.
//
// When `rootFolder` is given, every entry is nested under a single top-level folder of that name, so
// extracting the archive yields one tidy `<rootFolder>/` directory (GitHub-style) instead of spilling
// the selected files loose into the download location — the natural shape when the name matches the
// zip filename. Callers pass a validated name (no path separators), so folder() resolves to a scope.
export async function addSelectedToZip(
  zip: JSZip,
  baseDir: string,
  paths: string[],
  onSkip: (filePath: string, err: unknown) => void,
  rootFolder?: string,
) {
  const target = rootFolder ? (zip.folder(rootFolder) ?? zip) : zip;
  const sem = openFileLimiter();
  await Promise.all(
    paths.map(async (filePath) => {
      const resolved = path.resolve(filePath);
      if (!resolved.startsWith(baseDir + path.sep)) return;
      try {
        const stat = await sem.run(() => fs.stat(resolved));
        const relative = path.relative(baseDir, resolved);
        if (stat.isDirectory()) await addDirToZip(target, sem, resolved, relative);
        else target.file(relative, await sem.run(() => fs.readFile(resolved)));
      } catch (err) {
        onSkip(filePath, err);
      }
    }),
  );
}

// Stream the archive to the client as it's generated. generateInternalStream emits the zip in
// chunks; we pump those into a web ReadableStream so the response can start flowing before
// compression has finished, instead of awaiting a single in-memory buffer.
export function zipToStreamResponse(zip: JSZip, filename: string): Response {
  const internal = zip.generateInternalStream({
    type: "uint8array",
    compression: "DEFLATE",
    compressionOptions: { level: 1 },
    streamFiles: true,
  });

  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      internal
        .on("data", (chunk: Uint8Array) => controller.enqueue(chunk))
        .on("error", (err: Error) => controller.error(err))
        .on("end", () => controller.close());
      internal.resume();
    },
  });

  return new Response(body, {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${filename}.zip"`,
    },
  });
}
