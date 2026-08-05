// Safe, trigger-neutral tar transfers for one file, one directory, or the workspace root.
//
// The wire archive has exactly one virtual top-level entry named `payload`. That name never lands
// in the workspace: the receiver maps it to the caller's destination entry. This keeps local source
// names out of the remote layout and makes `put ./build dist` mean "merge build's contents into
// dist" without trusting a client-authored archive root.
//
// Only regular files and directories are part of the contract. File bytes stream unchanged and the
// sole preserved metadata bit is executable/non-executable (normalised to 0755/0644). Every other
// tar entry type is rejected before the staging tree is merged.

import fs from "fs/promises";
import { createReadStream, createWriteStream } from "fs";
import path from "path";
import { Readable } from "stream";
import { pipeline } from "stream/promises";
import tar from "tar-stream";
import { AppError } from "@/lib/errors/appError";
import { readTransferEntries } from "@/lib/files/entries";
import { openFileLimiter, type Semaphore } from "@/lib/files/fdLimit";
import { ignoreRuleFor } from "@/lib/files/ignore";
import { MAX_TRANSFER_BYTES, MAX_TRANSFER_ENTRIES, MAX_UPLOAD_BYTES } from "@/lib/uploads/limits";
import { checkFreeSpace, RESERVED_FREE_BYTES } from "@/lib/infra/storage/diskSpace";
import { fileSystemAppError, fileSystemCall } from "./errors";
import { requireDirPath, requireEntryPath, resolveHostPath } from "./paths";

export const TRANSFER_MEDIA_TYPE = "application/x-tar";
const PAYLOAD = "payload";

type TransferFile = {
  type: "file";
  relPath: string;
  hostPath: string;
  size: number;
  executable: boolean;
};

type TransferDirectory = {
  type: "directory";
  relPath: string;
  hostPath: string;
};

type TransferItem = TransferFile | TransferDirectory;

export interface PutTransferReceipt {
  created: string[];
  overwritten: string[];
  ignored: string[];
}

export class TransferApplyError extends Error {
  constructor(
    readonly receipt: PutTransferReceipt,
    readonly operationError: unknown,
  ) {
    super("transfer could not be fully applied");
    this.name = "TransferApplyError";
  }
}

function unsupported(relPath: string): AppError {
  return new AppError("INVALID_REQUEST", `${relPath || "The selected entry"} has an unsupported file type`, {
    field: "path",
  });
}

async function collectDirectory(
  hostPath: string,
  relPath: string,
  sem: Semaphore,
  items: TransferItem[],
): Promise<void> {
  items.push({ type: "directory", relPath, hostPath });
  const entries = await fileSystemCall(relPath || "The workspace root", () => readTransferEntries(hostPath, sem));
  for (const entry of entries) {
    const childRel = relPath === "" ? entry.name : path.posix.join(relPath, entry.name);
    const childHost = path.join(hostPath, entry.name);
    if (entry.isDirectory()) {
      await collectDirectory(childHost, childRel, sem, items);
      continue;
    }
    if (!entry.isFile()) throw unsupported(childRel);
    const stat = await fileSystemCall(childRel, () => sem.run(() => fs.stat(childHost)));
    items.push({
      type: "file",
      relPath: childRel,
      hostPath: childHost,
      size: stat.size,
      executable: (stat.mode & 0o111) !== 0,
    });
  }
}

/** Validate and collect a complete manifest before response headers are sent. */
export async function collectTransfer(rootDir: string, sourceValue: unknown): Promise<TransferItem[]> {
  const relPath = requireDirPath(sourceValue, "path");
  const root = await fs.realpath(rootDir);
  const hostPath = await resolveHostPath(rootDir, relPath);
  // resolveHostPath deliberately follows contained symlinks for ordinary file reads. A transfer has
  // a narrower type contract, so a selected symlink (or a path through one) must not be silently
  // converted into its target's bytes.
  if (path.resolve(root, relPath) !== hostPath) throw unsupported(relPath);
  const stat = await fileSystemCall(relPath || "The workspace root", () => fs.lstat(hostPath));
  if (stat.isSymbolicLink()) throw unsupported(relPath);
  if (stat.isFile()) {
    return [
      {
        type: "file",
        relPath: "",
        hostPath,
        size: stat.size,
        executable: (stat.mode & 0o111) !== 0,
      },
    ];
  }
  if (!stat.isDirectory()) throw unsupported(relPath);
  const items: TransferItem[] = [];
  await collectDirectory(hostPath, "", openFileLimiter(), items);
  return items;
}

function tarName(relPath: string): string {
  return relPath === "" ? PAYLOAD : `${PAYLOAD}/${relPath}`;
}

function addHeader(pack: tar.Pack, item: TransferDirectory): Promise<void> {
  return new Promise((resolve, reject) => {
    pack.entry({ name: tarName(item.relPath), type: "directory", mode: 0o755 }, (err) =>
      err ? reject(err) : resolve(),
    );
  });
}

async function addFile(pack: tar.Pack, item: TransferFile): Promise<void> {
  const target = pack.entry({
    name: tarName(item.relPath),
    type: "file",
    size: item.size,
    mode: item.executable ? 0o755 : 0o644,
  });
  await pipeline(createReadStream(item.hostPath), target);
}

/**
 * A Node stream suitable for Response(Readable.toWeb(...)).
 *
 * tar-stream's pack is a streamx stream, not a node:stream Readable, and it carries no
 * readableHighWaterMark. Handing it straight to Readable.toWeb throws ERR_MISSING_OPTION — which made
 * every pull answer INTERNAL_ERROR while the archive itself was being built perfectly. Wrapping it in a
 * real Readable here keeps that trap in one place and makes the signature honest, rather than leaving
 * each caller to discover it.
 */
export function packTransfer(items: TransferItem[]): Readable {
  const pack = tar.pack();
  void (async () => {
    try {
      for (const item of items) {
        if (item.type === "directory") await addHeader(pack, item);
        else await addFile(pack, item);
      }
      pack.finalize();
    } catch (err) {
      pack.destroy(err as Error);
    }
  })();
  return Readable.from(pack);
}

interface StagedItem {
  type: "file" | "directory";
  relPath: string;
  hostPath: string;
}

interface StagedTransfer {
  sourceType: "file" | "directory";
  items: StagedItem[];
  ignored: string[];
}

function archivePath(name: string): string {
  if (name.includes("\\") || name.includes("\0") || name.startsWith("/")) {
    throw new AppError("INVALID_REQUEST", "The transfer contains an invalid entry path", { field: "archive" });
  }
  const normalized = path.posix.normalize(name).replace(/\/$/, "");
  if (normalized !== name.replace(/\/$/, "") || (normalized !== PAYLOAD && !normalized.startsWith(`${PAYLOAD}/`))) {
    throw new AppError("INVALID_REQUEST", "Every transfer entry must be contained by payload", {
      field: "archive",
    });
  }
  return normalized === PAYLOAD ? "" : normalized.slice(PAYLOAD.length + 1);
}

function ignoredTransferPath(relPath: string, isDirectory: boolean): boolean {
  if (relPath === "") return false; // the explicitly selected source itself always travels
  const segments = relPath.split("/");
  const directorySegments = isDirectory ? segments : segments.slice(0, -1);
  if (directorySegments.some((segment) => ignoreRuleFor(segment, true) !== undefined)) return true;
  return !isDirectory && ignoreRuleFor(segments[segments.length - 1], false) !== undefined;
}

async function drain(stream: NodeJS.ReadableStream): Promise<void> {
  stream.resume();
  await new Promise<void>((resolve, reject) => {
    stream.once("end", resolve);
    stream.once("error", reject);
  });
}

async function extractToStage(body: Readable, stageDir: string): Promise<StagedTransfer> {
  const extract = tar.extract();
  const items: StagedItem[] = [];
  const ignored: string[] = [];
  const seen = new Set<string>();
  let sourceType: "file" | "directory" | undefined;
  // Aggregate cost of this one request. Checked as each header arrives, so an over-large transfer is
  // refused while it is still being read rather than after its bytes are on disk.
  let entryCount = 0;
  let totalBytes = 0;

  const completed = new Promise<void>((resolve, reject) => {
    extract.on("entry", (header, stream, next) => {
      void (async () => {
        const relPath = archivePath(header.name);

        entryCount += 1;
        if (entryCount > MAX_TRANSFER_ENTRIES) {
          throw new AppError("TRANSFER_TOO_LARGE", "The transfer contains too many entries", {
            field: "archive",
            limitEntries: MAX_TRANSFER_ENTRIES,
          });
        }
        totalBytes += header.size ?? 0;
        if (totalBytes > MAX_TRANSFER_BYTES) {
          throw new AppError("TRANSFER_TOO_LARGE", "The transfer is over the total size limit", {
            field: "archive",
            limitBytes: MAX_TRANSFER_BYTES,
          });
        }

        if (seen.has(relPath)) {
          throw new AppError("INVALID_REQUEST", `The transfer contains the duplicate entry ${header.name}`, {
            field: "archive",
          });
        }
        seen.add(relPath);

        if (header.type !== "file" && header.type !== "directory") throw unsupported(header.name);
        if (relPath === "") {
          sourceType = header.type;
        } else if (sourceType !== "directory") {
          throw new AppError("INVALID_REQUEST", "A file payload cannot contain child entries", { field: "archive" });
        }

        const isDirectory = header.type === "directory";
        if (ignoredTransferPath(relPath, isDirectory)) {
          ignored.push(relPath);
          await drain(stream);
          return;
        }

        const stagedPath = relPath === "" ? path.join(stageDir, PAYLOAD) : path.join(stageDir, PAYLOAD, relPath);
        if (isDirectory) {
          await fs.mkdir(stagedPath, { recursive: true, mode: 0o755 });
          await drain(stream);
          items.push({ type: "directory", relPath, hostPath: stagedPath });
          return;
        }

        const size = header.size ?? 0;
        if (size > MAX_UPLOAD_BYTES) {
          throw new AppError("FILE_TOO_LARGE", `${relPath || "The transferred file"} is over the per-file limit`, {
            field: "archive",
            limitBytes: MAX_UPLOAD_BYTES,
          });
        }
        const space = await checkFreeSpace(stageDir, size, RESERVED_FREE_BYTES);
        if (!space.ok) throw new AppError("STORAGE_EXHAUSTED", "Not enough free disk space to accept this transfer");
        await fs.mkdir(path.dirname(stagedPath), { recursive: true });
        const mode = (header.mode ?? 0) & 0o111 ? 0o755 : 0o644;
        await pipeline(stream, createWriteStream(stagedPath, { flags: "wx", mode }));
        // Creation mode is filtered through the process umask; chmod makes the promised normalized
        // mode exact before the staged inode is renamed into the workspace.
        await fs.chmod(stagedPath, mode);
        items.push({ type: "file", relPath, hostPath: stagedPath });
      })()
        .then(() => next())
        .catch((err) => extract.destroy(err as Error));
    });
    body.once("error", reject);
    extract.once("finish", resolve);
    extract.once("error", reject);
  });

  body.pipe(extract);
  await completed;
  if (!sourceType || !seen.has("")) {
    throw new AppError("INVALID_REQUEST", "The transfer must contain one payload entry", { field: "archive" });
  }
  return { sourceType, items, ignored };
}

async function existingType(hostPath: string): Promise<"file" | "directory" | "unsupported" | "missing"> {
  try {
    const stat = await fs.lstat(hostPath);
    if (stat.isFile()) return "file";
    if (stat.isDirectory()) return "directory";
    return "unsupported";
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return "missing";
    throw err;
  }
}

function targetPath(sourceType: "file" | "directory", dest: string, relPath: string): string {
  if (sourceType === "file") return dest;
  if (dest === "") return relPath;
  return relPath === "" ? dest : path.posix.join(dest, relPath);
}

/**
 * Stage and validate the complete body, preflight all destination type conflicts, then merge. A
 * runtime filesystem failure during the final merge carries the successfully applied subset so the
 * route can snapshot and report it rather than presenting a partial write as an opaque failure.
 */
export async function putTransfer(
  rootDir: string,
  destValue: unknown,
  body: Readable,
  options: { beforeApply?: () => Promise<void> } = {},
): Promise<PutTransferReceipt> {
  const root = await fs.realpath(rootDir);
  const stageDir = await fs.mkdtemp(path.join(path.dirname(root), ".paodo-transfer-"));
  const receipt: PutTransferReceipt = { created: [], overwritten: [], ignored: [] };
  try {
    const staged = await extractToStage(body, stageDir);
    const dest =
      staged.sourceType === "file"
        ? requireEntryPath(destValue, "dest")
        : requireDirPath(destValue, "dest");
    receipt.ignored = staged.ignored.map((relPath) => targetPath(staged.sourceType, dest, relPath));

    const planned: Array<StagedItem & { targetRel: string; targetHost: string; existed: boolean }> = [];
    for (const item of staged.items) {
      const targetRel = targetPath(staged.sourceType, dest, item.relPath);
      // The root directory marker carries the source kind but needs no filesystem operation.
      if (targetRel === "" && item.type === "directory") continue;
      const targetHost = await resolveHostPath(root, targetRel, "dest");
      // Same rule collectTransfer applies on the way out, and for the same reason: resolveHostPath
      // deliberately follows contained symlinks, but a transfer only carries regular files and
      // directories. Without this, pushing `report.txt` where that name is a link to
      // `final-report.txt` overwrites the link's target — a file the receipt never names — while
      // reporting `report.txt`. Refused here in preflight, so the whole transfer is still untouched.
      if (path.resolve(root, targetRel) !== targetHost) {
        throw new AppError("CONFLICT", `${targetRel} resolves through a symbolic link`, { field: "dest" });
      }
      const type = await fileSystemCall(targetRel, () => existingType(targetHost));
      if (type === "unsupported" || (type !== "missing" && type !== item.type)) {
        throw new AppError("CONFLICT", `${targetRel} conflicts with an existing ${type} entry`, { field: "dest" });
      }
      planned.push({ ...item, targetRel, targetHost, existed: type !== "missing" });
    }

    planned.sort((a, b) => {
      if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
      return a.targetRel.split("/").length - b.targetRel.split("/").length;
    });

    await options.beforeApply?.();

    try {
      for (const item of planned) {
        if (item.type === "directory") {
          if (!item.existed) {
            await fileSystemCall(item.targetRel, () => fs.mkdir(item.targetHost, { recursive: true, mode: 0o755 }));
            receipt.created.push(item.targetRel);
          }
          continue;
        }
        await fileSystemCall(item.targetRel, () => fs.mkdir(path.dirname(item.targetHost), { recursive: true }));
        await fileSystemCall(item.targetRel, () => fs.rename(item.hostPath, item.targetHost));
        (item.existed ? receipt.overwritten : receipt.created).push(item.targetRel);
      }
    } catch (err) {
      throw new TransferApplyError(receipt, err);
    }

    return receipt;
  } finally {
    await fs.rm(stageDir, { recursive: true, force: true });
  }
}

/** Public classification for a failure that occurred after some staged entries were applied. */
export function transferApplyAppError(error: TransferApplyError): AppError | null {
  if (error.operationError instanceof AppError) return error.operationError;
  const last = error.receipt.overwritten.at(-1) ?? error.receipt.created.at(-1) ?? "The transfer destination";
  return fileSystemAppError(error.operationError, last);
}
