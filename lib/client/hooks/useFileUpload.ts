"use client";

import { useRef, useState } from "react";
import { MAX_UPLOAD_BYTES, formatBytes } from "@/lib/workspace/uploadLimits";
import { partitionByIgnore } from "@/lib/workspace/uploadIgnore";

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
  /**
   * Subset of `notUploaded` that were rejected as over the per-file size limit (413). Tracked
   * separately rather than inferred from whether `hardFailure` is set: with bounded concurrency,
   * a sibling worker can hit a 413 (skip, keep draining) in the same run where another worker's
   * failure later aborts the batch, so both categories can legitimately appear in `notUploaded`
   * together.
   */
  overLimit: string[];
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
  const overLimit: string[] = [];
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

  // Set by whichever worker hits the first systemic failure. Workers never throw out to
  // Promise.all below — if one did, Promise.all would settle (and this function would return) the
  // moment that first worker rejects, without waiting for its siblings to unwind, so a sibling file
  // that was genuinely in flight at that instant would never get its own notUploaded push recorded.
  // Recording the failure and returning normally instead means Promise.all genuinely waits for every
  // worker to finish draining or aborting before this function reads its results.
  //
  // Held in an object (not a plain `let`) because TS's control-flow narrowing doesn't account for a
  // captured variable being reassigned inside these closures — it would otherwise narrow the type to
  // `null` at the read site below regardless of what the workers actually did.
  const failure: { first: Error | null } = { first: null };

  const worker = async () => {
    while (queue.length > 0) {
      const entry = queue.shift()!;
      let res: Response;
      try {
        res = await send(entry);
      } catch (err) {
        // Either a genuine per-request failure (network drop, ...) or this worker got aborted
        // because a sibling already failed the batch — either way, this entry didn't upload.
        notUploaded.push(entry.path);
        if (!controller.signal.aborted) {
          failure.first = err instanceof Error ? err : new Error("Upload failed.");
          controller.abort();
        }
        return;
      }
      if (res.status === 413) {
        notUploaded.push(entry.path);
        overLimit.push(entry.path);
        continue;
      }
      if (!res.ok) {
        notUploaded.push(entry.path);
        failure.first = new Error(`${entry.path} — ${await failureReason(res)}`);
        controller.abort();
        return;
      }
      uploaded += 1;
      opts.onProgress?.(uploaded);
    }
  };

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, worker));
  if (failure.first) {
    hardFailure = failure.first.message;
    // Whatever was still sitting in the queue when the abort fired was never attempted at all.
    notUploaded.push(...queue.map((entry) => entry.path));
  }

  return { uploaded, notUploaded, overLimit, hardFailure };
}

/** Result of the most recently finished upload batch, shown in the results popup. */
export interface UploadSummary {
  uploaded: number;
  /**
   * Every path that didn't make it in, for any reason — excluded by an ignore pattern, over the
   * per-file size limit, rejected by the server, or never attempted because a systemic failure
   * stopped the queue. `uploaded + failed.length` is always the size of the attempted batch.
   */
  failed: string[];
  /**
   * One line per triggered failure category — e.g. `node_modules excluded (12 files)`, `3 files
   * over the 1 GB limit` — so the cause of a batch of failures reads as a single sentence instead
   * of forcing the reader to infer it from the raw path list below.
   */
  notes: string[];
  /** Set only when a systemic failure (507, 400, 500, network) stopped the batch early. */
  stoppedReason: string | null;
}

/**
 * Shared upload logic for the file tree panel — used by both the Files/Folder buttons and the
 * drag-and-drop zone. Every entry point funnels into one per-file uploader.
 */
export function useFileUpload(apiBase: string, onUploaded: () => void) {
  const [status, setStatus] = useState<string | null>(null);
  const [summary, setSummary] = useState<UploadSummary | null>(null);
  // Authoritative "one upload at a time" guard. A ref is synchronous and render-independent, so a
  // second call in the same tick is rejected immediately, unlike the status state which only
  // reflects after a re-render.
  const inFlight = useRef(false);

  const uploadEntries = async (entries: PathedFile[], applyIgnorePatterns: boolean) => {
    if (entries.length === 0) return;
    if (inFlight.current) return;
    inFlight.current = true;
    setSummary(null);
    // Set synchronously so the panel shows busy from the first click rather than appearing idle.
    setStatus("Uploading…");

    // Folder uploads default-exclude generated directories (node_modules, .venv, ...) silently —
    // no confirmation step, since it's just as easy to say so in the results list afterward as it
    // is to ask first. Never applied to the plain Files button or a flat-file drop.
    const excluded = applyIgnorePatterns ? partitionByIgnore(entries).excluded : new Map<string, PathedFile[]>();
    const excludedPaths = Array.from(excluded.values())
      .flat()
      .map((entry) => entry.path);
    const excludedSet = new Set(excludedPaths);
    const candidates = entries.filter((entry) => !excludedSet.has(entry.path));

    // Checked before a single byte leaves the browser: an individually-oversized file is excluded
    // from the queue up front rather than discovered at file 16,000 of 18,000. This is a skip, not a
    // reason to fail the batch — the rest of a real folder (e.g. a vendored binary sitting next to
    // thousands of legitimate source files) has every reason to still upload. The server enforces the
    // same limit on every request regardless, so this is an optimization (skip the doomed request
    // entirely) plus an up-front explanation, not the actual guard.
    const clientOversized = candidates.filter((entry) => entry.file.size > MAX_UPLOAD_BYTES).map((entry) => entry.path);
    const queue = candidates.filter((entry) => entry.file.size <= MAX_UPLOAD_BYTES);

    // One line per triggered category.
    const notesFor = (overLimitCount: number): string[] => {
      const notes = Array.from(excluded.entries()).map(
        ([name, group]) => `${name} excluded (${group.length} file${group.length === 1 ? "" : "s"})`,
      );
      if (overLimitCount > 0) {
        notes.push(
          `${overLimitCount} file${overLimitCount === 1 ? "" : "s"} over the ${formatBytes(MAX_UPLOAD_BYTES)} limit`,
        );
      }
      return notes;
    };

    if (queue.length === 0) {
      // Nothing left to send — everything was excluded or oversized. No onUploaded() call: nothing
      // in the workspace changed.
      setSummary({
        uploaded: 0,
        failed: [...excludedPaths, ...clientOversized],
        notes: notesFor(clientOversized.length),
        stoppedReason: null,
      });
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
      const overLimitCount = clientOversized.length + result.overLimit.length;
      setSummary({
        uploaded: result.uploaded,
        failed: [...excludedPaths, ...clientOversized, ...result.notUploaded],
        notes: notesFor(overLimitCount),
        stoppedReason: result.hardFailure,
      });
      onUploaded();
    } finally {
      setStatus(null);
      inFlight.current = false;
    }
  };

  // Single files: the name is the whole path, so they land at the root of the target directory.
  const uploadFiles = (files: File[]) =>
    uploadEntries(
      files.map((file) => ({ file, path: file.name })),
      false,
    );

  // <input webkitdirectory> yields flat File[] with webkitRelativePath carrying the structure.
  const uploadFolder = (files: File[]) =>
    uploadEntries(
      files.map((file) => ({ file, path: file.webkitRelativePath || file.name })),
      true,
    );

  // Used by drag-and-drop, which already has PathedFile[] in hand (built while walking the dropped
  // entries) — applyIgnorePatterns is true only for a dropped folder, never a flat multi-file drop.
  const uploadPathedFiles = (entries: PathedFile[], applyIgnorePatterns: boolean) =>
    uploadEntries(entries, applyIgnorePatterns);

  return { status, summary, uploadFiles, uploadFolder, uploadPathedFiles };
}
