"use client";

import { useRef, useState } from "react";
import { MAX_UPLOAD_BYTES, formatBytes } from "@/lib/uploads/limits";
import { partitionByIgnore } from "@/lib/files/ignore";

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
  /** Every path that didn't make it in — each file is attempted on its own, so one failure only ever costs that one file. */
  notUploaded: string[];
  /** Subset of `notUploaded` rejected as over the per-file size limit (413), tracked so the summary can say "over the limit" rather than lumping them with genuine errors. */
  overLimit: string[];
  /** A representative server-provided reason a file failed (507 out of disk, 500, ...), shown for context. Informational only — it never stops the rest of the queue. */
  errorSummary: string | null;
}

/**
 * Drain an upload queue, one request per file, bounded concurrency. Pulled out of the hook so its
 * per-file behavior (every file is attempted; a failure only ever costs that one file) can be
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
  // First server-provided failure reason seen, kept only so the summary can explain why files failed.
  // It never stops the queue — a file that can't upload is set aside and the rest keep going.
  let errorSummary: string | null = null;

  // Send one file, waiting out rate-limit pushback rather than counting a throttled file as failed.
  const send = async (entry: PathedFile): Promise<Response> => {
    for (let attempt = 0; ; attempt += 1) {
      const res = await fetch(`${opts.apiBase}/files/upload?path=${encodeURIComponent(entry.path)}`, {
        method: "POST",
        body: entry.file,
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
      let res: Response;
      try {
        res = await send(entry);
      } catch {
        // A network drop on one file (or a throttled file that ran out of retries) costs only that
        // file — record it and move on to the next.
        notUploaded.push(entry.path);
        errorSummary ??= "Some files could not be uploaded — check your connection and try them again.";
        continue;
      }
      if (res.status === 413) {
        notUploaded.push(entry.path);
        overLimit.push(entry.path);
        continue;
      }
      if (!res.ok) {
        notUploaded.push(entry.path);
        errorSummary ??= await failureReason(res);
        continue;
      }
      uploaded += 1;
      opts.onProgress?.(uploaded);
    }
  };

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, worker));

  return { uploaded, notUploaded, overLimit, errorSummary };
}

/** Result of the most recently finished upload batch, shown in the results popup. */
export interface UploadSummary {
  uploaded: number;
  /**
   * Files we actually tried to put in and couldn't — over the per-file size limit, or rejected by
   * the server / lost to the network. These are genuine failures: each is attempted on its own, so
   * this only ever holds the specific files that couldn't upload, and `uploaded + failed.length` is
   * the size of the attempted batch. Ignore-rule exclusions are deliberately NOT here — those are
   * intentional, counted in `excluded`, and the upload lands fully around them.
   */
  failed: string[];
  /** How many files the ignore rule left out (node_modules, .git, ...). Intentional, not a failure — reported for transparency only; the rest of the drop still uploads. */
  excluded: number;
  /**
   * One line per triggered category — e.g. `node_modules excluded (12 files)`, `3 files over the
   * 1 GB limit` — so each cause reads as a single sentence instead of forcing the reader to infer it
   * from the raw path list below.
   */
  notes: string[];
  /** A representative reason files failed (507 out of disk, 500, network, ...), shown for context. Informational — nothing was stopped on its account. */
  errorSummary: string | null;
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
      // in the workspace changed. Excluded files are intentional, so only the oversized ones count
      // as failures here.
      setSummary({
        uploaded: 0,
        failed: [...clientOversized],
        excluded: excludedPaths.length,
        notes: notesFor(clientOversized.length),
        errorSummary: null,
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
        failed: [...clientOversized, ...result.notUploaded],
        excluded: excludedPaths.length,
        notes: notesFor(overLimitCount),
        errorSummary: result.errorSummary,
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
