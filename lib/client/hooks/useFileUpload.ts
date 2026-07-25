"use client";

import { useRef, useState } from "react";
import { MAX_UPLOAD_BYTES } from "@/lib/workspace/uploadLimits";

/** A file paired with its intended path inside the workspace (folder uploads keep structure). */
export interface PathedFile {
  file: File;
  path: string;
}

// Files go up one request each, in parallel but bounded: enough sockets to keep a fast link busy on
// a tree of small files, few enough to stay inside the server's per-workspace upload rate limit.
// They are deliberately NOT bundled into an archive first — that would mean holding the whole
// archive in browser memory before sending a byte, and holding it again server-side to read it.
const CONCURRENCY = 6;

// Thousands of files would mean thousands of re-renders, and no one reads every increment.
const PROGRESS_STEP = 10;

// A large tree can push files faster than the server's upload limiter refills, so a 429 is expected
// backpressure rather than a failure — dropping a 10,000-file batch because file 8,000 arrived a
// second early would be indefensible. Retry-After says exactly how long to hold off.
const RATE_LIMIT_RETRIES = 5;
const RETRY_AFTER_CAP_SECONDS = 30;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Prefer the server's own explanation: a 413 body carries the actual size and the limit. */
const failureReason = async (res: Response): Promise<string> => {
  const body = (await res.json().catch(() => null)) as { error?: string } | null;
  return body?.error ?? `${res.status} ${res.statusText}`.trim();
};

export interface UploadQueueResult {
  uploaded: number;
  /**
   * Every path that didn't make it in — a 413 (skipped, the queue kept draining) or, on a systemic
   * failure, the file that failed plus everything still queued behind it (never attempted).
   */
  notUploaded: string[];
  /** Set only on a systemic failure (507, 400, 500, network) that stopped the remaining queue. */
  hardFailure: string | null;
}

/**
 * Drain an upload queue, one request per file, bounded concurrency. Pulled out of the hook so the
 * skip-vs-abort behavior (413 skips and keeps going; anything else stops the remaining queue) can be
 * unit-tested against a mocked fetch, independent of React state.
 */
export async function runUploadQueue(
  initialQueue: PathedFile[],
  opts: { apiBase: string; onProgress?: (uploaded: number) => void },
): Promise<UploadQueueResult> {
  const queue = [...initialQueue];
  const notUploaded: string[] = [];
  let uploaded = 0;
  let hardFailure: string | null = null;

  // A systemic failure (507 out of disk, 400 path traversal, 500, network) fails the batch: abort
  // the in-flight siblings rather than pressing on and burying the cause under a pile of
  // consequential errors. An individual 413 is handled separately below — it says nothing about the
  // files still queued behind it.
  const controller = new AbortController();

  // Send one file, waiting out rate-limit pushback rather than failing the batch for it.
  const send = async (entry: PathedFile): Promise<Response> => {
    for (let attempt = 0; ; attempt += 1) {
      const res = await fetch(`${opts.apiBase}/files/upload?path=${encodeURIComponent(entry.path)}`, {
        method: "POST",
        body: entry.file,
        signal: controller.signal,
      });
      if (res.status !== 429 || attempt === RATE_LIMIT_RETRIES) return res;

      const retryAfter = Number(res.headers.get("retry-after"));
      const seconds = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : 1;
      await sleep(Math.min(seconds, RETRY_AFTER_CAP_SECONDS) * 1000);
    }
  };

  const worker = async () => {
    while (queue.length > 0) {
      const entry = queue.shift()!;
      const res = await send(entry);
      if (res.status === 413) {
        notUploaded.push(entry.path);
        continue;
      }
      if (!res.ok) {
        notUploaded.push(entry.path);
        throw new Error(`${entry.path} — ${await failureReason(res)}`);
      }
      uploaded += 1;
      opts.onProgress?.(uploaded);
    }
  };

  try {
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, worker));
  } catch (err) {
    controller.abort();
    hardFailure = err instanceof Error ? err.message : "Upload failed.";
    // Whatever was still sitting in the queue when the abort fired was never attempted at all.
    notUploaded.push(...queue.map((entry) => entry.path));
  }

  return { uploaded, notUploaded, hardFailure };
}

/**
 * Shared upload logic for the file tree panel — used by both the Files/Folder buttons and the
 * drag-and-drop zone. Every entry point funnels into one per-file uploader.
 */
export function useFileUpload(apiBase: string, onUploaded: () => void) {
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Flat list of paths that didn't make it in this run — oversized, or never attempted because a
  // systemic failure stopped the queue. Shown verbatim in a simple text box by the caller so the
  // user can see exactly what didn't upload, regardless of which of those reasons applied.
  const [notUploaded, setNotUploaded] = useState<string[]>([]);
  // Authoritative "one upload at a time" guard. A ref is synchronous and render-independent, so a
  // second call in the same tick is rejected immediately, unlike the status state which only
  // reflects after a re-render.
  const inFlight = useRef(false);

  const uploadPathedFiles = async (entries: PathedFile[]) => {
    if (entries.length === 0) return;
    if (inFlight.current) return;
    inFlight.current = true;
    setError(null);
    setNotUploaded([]);
    // Set synchronously so the panel shows busy from the first click rather than appearing idle.
    setStatus("Uploading…");

    // Checked before a single byte leaves the browser: an individually-oversized file is excluded
    // from the queue up front rather than discovered at file 16,000 of 18,000. This is a skip, not a
    // reason to fail the batch — the rest of a real folder (e.g. a vendored binary sitting next to
    // thousands of legitimate source files) has every reason to still upload. The server enforces the
    // same limit on every request regardless, so this is an optimization (skip the doomed request
    // entirely) plus an up-front explanation, not the actual guard.
    const clientOversized = entries.filter((entry) => entry.file.size > MAX_UPLOAD_BYTES);
    const queue = entries.filter((entry) => entry.file.size <= MAX_UPLOAD_BYTES);

    if (queue.length === 0) {
      // The whole selection was oversized — nothing to upload, so this IS a failure to report, not
      // a caveat on a completed batch. No onUploaded() call: nothing in the workspace changed.
      setError(clientOversized.length === 1 ? "Nothing was uploaded — the file is over the size limit." : "Nothing was uploaded — every file was over the size limit.");
      setNotUploaded(clientOversized.map((entry) => entry.path));
      setStatus(null);
      inFlight.current = false;
      return;
    }

    try {
      const result = await runUploadQueue(queue, {
        apiBase,
        onProgress: (uploaded) => {
          if (uploaded === queue.length || uploaded % PROGRESS_STEP === 0) {
            setStatus(`Uploading ${uploaded}/${entries.length}…`);
          }
        },
      });

      const notUploadedPaths = [...clientOversized.map((entry) => entry.path), ...result.notUploaded];
      setNotUploaded(notUploadedPaths);

      if (result.hardFailure) {
        // Say plainly how far it got — this batch is partly applied, and implying otherwise would
        // send the user looking for files that are already there.
        setError(
          result.uploaded === 0
            ? `Nothing was uploaded — ${result.hardFailure}`
            : `Upload stopped after ${result.uploaded} of ${entries.length} files — ${result.hardFailure}`,
        );
      } else if (notUploadedPaths.length > 0) {
        // Completed without a systemic abort — the skips are a caveat on an otherwise finished
        // upload, not a failure. The exact paths are in notUploaded, not repeated here.
        setError(
          `Uploaded ${result.uploaded} of ${entries.length} files — ${notUploadedPaths.length} file${notUploadedPaths.length === 1 ? "" : "s"} not uploaded.`,
        );
      }
      onUploaded();
    } finally {
      setStatus(null);
      inFlight.current = false;
    }
  };

  // Single files: the name is the whole path, so they land at the root of the target directory.
  const uploadFiles = (files: File[]) => uploadPathedFiles(files.map((file) => ({ file, path: file.name })));

  // <input webkitdirectory> yields flat File[] with webkitRelativePath carrying the structure.
  const uploadFolder = (files: File[]) =>
    uploadPathedFiles(files.map((file) => ({ file, path: file.webkitRelativePath || file.name })));

  return { status, error, notUploaded, uploadFiles, uploadFolder, uploadPathedFiles };
}
