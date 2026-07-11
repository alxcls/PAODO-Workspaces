import type { PathedFile } from "@/lib/client/hooks/useFileUpload";

// Minimal shape of the (non-standard but universally supported) FileSystem entry API used by
// drag-and-drop. A browser drop only exposes top-level dataTransfer.files, so descending into
// dropped folders requires webkitGetAsEntry() + a directory reader.
interface FsEntry {
  isFile: boolean;
  isDirectory: boolean;
  name: string;
  file?: (onSuccess: (f: File) => void, onError: (e: unknown) => void) => void;
  createReader?: () => {
    readEntries: (onSuccess: (entries: FsEntry[]) => void, onError: (e: unknown) => void) => void;
  };
}

function entryFile(entry: FsEntry): Promise<File> {
  return new Promise((resolve, reject) => entry.file!(resolve, reject));
}

// readEntries returns at most ~100 entries per call, so it must be drained in a loop.
function readAll(reader: ReturnType<NonNullable<FsEntry["createReader"]>>): Promise<FsEntry[]> {
  const out: FsEntry[] = [];
  return new Promise((resolve, reject) => {
    const next = () =>
      reader.readEntries((batch) => {
        if (batch.length === 0) return resolve(out);
        out.push(...batch);
        next();
      }, reject);
    next();
  });
}

async function walk(entry: FsEntry, prefix: string, out: PathedFile[]): Promise<void> {
  if (entry.isFile) {
    out.push({ file: await entryFile(entry), path: prefix + entry.name });
  } else if (entry.isDirectory && entry.createReader) {
    const children = await readAll(entry.createReader());
    for (const child of children) await walk(child, `${prefix}${entry.name}/`, out);
  }
}

export interface DroppedFiles {
  files: PathedFile[];
  /** True when any dropped item was a folder — callers zip these instead of uploading individually. */
  hasDirectory: boolean;
}

/**
 * Flatten a drag-and-drop DataTransfer into files with workspace-relative paths, recursing into
 * any dropped folders. Falls back to dataTransfer.files if the entry API is unavailable.
 */
export async function readDroppedEntries(dt: DataTransfer): Promise<DroppedFiles> {
  // getAsEntry must be called synchronously before any await — the items list is cleared after.
  const entries = Array.from(dt.items)
    .filter((item) => item.kind === "file")
    .map((item) => (item.webkitGetAsEntry?.() as FsEntry | null) ?? null)
    .filter((e): e is FsEntry => e !== null);

  if (entries.length === 0) {
    const files = Array.from(dt.files).map((file) => ({ file, path: file.name }));
    return { files, hasDirectory: false };
  }

  const files: PathedFile[] = [];
  let hasDirectory = false;
  for (const entry of entries) {
    if (entry.isDirectory) hasDirectory = true;
    await walk(entry, "", files);
  }
  return { files, hasDirectory };
}
