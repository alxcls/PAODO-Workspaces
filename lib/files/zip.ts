/**
 * Shared helpers for the file-download routes (workspace + drive): take a list of caller-selected
 * paths and stream them back as a single ZIP.
 *
 * Fast DEFLATE (level 1 — a fraction of the CPU of the default level 6 on source trees, with similar
 * ratios) and streaming generation keep large selections cheap. All filesystem access goes through
 * the shared descriptor budget (./fdLimit.ts): a naive Promise.all over a large tree hits EMFILE and
 * silently drops the unreadable files from the archive.
 *
 * What travels is the shared ignore contract (./ignore.ts), the same answer the tree and an upload
 * give — a zip carrying node_modules the tree never showed would be the two sides disagreeing about
 * what the workspace is. A path named EXPLICITLY by the caller is archived even when the contract
 * would exclude it: that is a deliberate selection, not a traversal.
 */

import fs from "fs/promises";
import path from "path";
import type JSZip from "jszip";
import { resolveContained } from "./containment";
import { readTransferEntries } from "./entries";
import { openFileLimiter, type Semaphore } from "./fdLimit";
import { relativeEntryPath } from "./relpath";

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

/**
 * The deepest directory every selection shares, as a trailing-slash prefix ("" when they share
 * nothing). Measured segment-wise on each path's PARENT, so `src/app` and `src/application` share
 * `src/`, a lone directory keeps its own name, and a directory selected alongside a file inside it
 * still yields a well-formed entry rather than an empty one.
 */
function commonParentPrefix(entryPaths: string[]): string {
  const parents = entryPaths.map((entryPath) => entryPath.split("/").slice(0, -1));
  let shared = parents[0] ?? [];
  for (const parent of parents.slice(1)) {
    let i = 0;
    while (i < shared.length && i < parent.length && shared[i] === parent[i]) i++;
    shared = shared.slice(0, i);
  }
  return shared.length > 0 ? `${shared.join("/")}/` : "";
}

/**
 * The name an entry takes in the archive: the workspace-relative path minus the prefix every
 * selection shares, so downloading one nested file yields that file rather than the empty ancestry
 * above it. Stripping only ever shortens a name, but a malformed result would be a zip-slip against
 * whoever extracts it — anything not a plain relative name falls back to the full path.
 */
function zipEntryName(entryPath: string, prefix: string): string {
  if (prefix === "" || !entryPath.startsWith(prefix)) return entryPath;
  const stripped = entryPath.slice(prefix.length);
  if (stripped === "" || stripped.startsWith("/") || stripped.split("/").includes("..")) return entryPath;
  return stripped;
}

/**
 * Add each caller-selected path to the zip, recursing into directories. `paths` are
 * workspace-relative (./relpath.ts), the same space the file tree serves and the content route
 * accepts; entries are named by zipEntryName above.
 *
 * A path that cannot be archived is reported through `onSkip` and left out rather than aborting the
 * whole archive — an unreadable file should not cost the user the other 900 — and that includes a
 * path failing containment, which would otherwise be a short archive presented as a complete one.
 * Containment goes through resolveContained rather than a lexical prefix check, so a symlink inside
 * the tree pointing at /etc is refused instead of having its target read into the archive.
 *
 * When `rootFolder` is given, every entry is nested under a single top-level folder of that name, so
 * extracting yields one tidy directory instead of spilling the selection loose into the download
 * location. Callers pass a validated name (no path separators), so folder() resolves to a scope.
 */
export async function addSelectedToZip(
  zip: JSZip,
  baseDir: string,
  paths: string[],
  onSkip: (filePath: string, err: unknown) => void,
  rootFolder?: string,
) {
  const target = rootFolder ? (zip.folder(rootFolder) ?? zip) : zip;
  const sem = openFileLimiter();

  // Validate up front: the shared prefix has to be known before the first entry is named.
  const selected: { relPath: string; entryPath: string }[] = [];
  for (const relPath of paths) {
    try {
      selected.push({ relPath, entryPath: relativeEntryPath(relPath) });
    } catch (err) {
      onSkip(relPath, err);
    }
  }
  const prefix = commonParentPrefix(selected.map((entry) => entry.entryPath));

  await Promise.all(
    selected.map(async ({ relPath, entryPath }) => {
      try {
        const resolved = await resolveContained(baseDir, entryPath);
        if (resolved === null) throw new Error("Path resolves outside the workspace");
        const zipPath = zipEntryName(entryPath, prefix);
        const stat = await sem.run(() => fs.stat(resolved));
        if (stat.isDirectory()) await addDirToZip(target, sem, resolved, zipPath);
        else target.file(zipPath, await sem.run(() => fs.readFile(resolved)));
      } catch (err) {
        onSkip(relPath, err);
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
