"use client";

import { useRef, useState } from "react";
import { MAX_UPLOAD_BYTES, formatBytes } from "@/lib/workspace/uploadLimits";

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

// Naming the offending files matters more than listing every one; past a few the message stops being
// readable and the count carries the rest.
const NAMED_IN_ERROR = 3;

// Thousands of files would mean thousands of re-renders, and no one reads every increment.
const PROGRESS_STEP = 10;

// A large tree can push files faster than the server's upload limiter refills, so a 429 is expected
// backpressure rather than a failure — dropping a 10,000-file batch because file 8,000 arrived a
// second early would be indefensible. Retry-After says exactly how long to hold off.
const RATE_LIMIT_RETRIES = 5;
const RETRY_AFTER_CAP_SECONDS = 30;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Explain an oversized selection. This is the message the user gets instead of a 413, and it has to
 * answer "why did nothing happen" on its own — so it names the files, their sizes, and the limit.
 */
const oversizedMessage = (oversized: PathedFile[]): string => {
  const limit = formatBytes(MAX_UPLOAD_BYTES);
  const named = oversized
    .slice(0, NAMED_IN_ERROR)
    .map((entry) => `${entry.path} (${formatBytes(entry.file.size)})`)
    .join(", ");
  const rest = oversized.length - NAMED_IN_ERROR;
  return oversized.length === 1
    ? `Nothing was uploaded — ${named} is over the ${limit} per-file limit.`
    : `Nothing was uploaded — ${oversized.length} files are over the ${limit} per-file limit: ${named}` +
        `${rest > 0 ? `, and ${rest} more` : ""}.`;
};

/** Prefer the server's own explanation: a 413 body carries the actual size and the limit. */
const failureReason = async (res: Response): Promise<string> => {
  const body = (await res.json().catch(() => null)) as { error?: string } | null;
  return body?.error ?? `${res.status} ${res.statusText}`.trim();
};

/**
 * Shared upload logic for the file tree panel — used by both the Files/Folder buttons and the
 * drag-and-drop zone. Every entry point funnels into one per-file uploader.
 */
export function useFileUpload(apiBase: string, onUploaded: () => void) {
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Authoritative "one upload at a time" guard. A ref is synchronous and render-independent, so a
  // second call in the same tick is rejected immediately, unlike the status state which only
  // reflects after a re-render.
  const inFlight = useRef(false);

  const uploadPathedFiles = async (entries: PathedFile[]) => {
    if (entries.length === 0) return;
    if (inFlight.current) return;
    inFlight.current = true;
    setError(null);
    // Set synchronously so the panel shows busy from the first click rather than appearing idle.
    setStatus("Uploading…");

    let uploaded = 0;
    try {
      // All-or-nothing on size, checked before a single byte leaves the browser: otherwise a user
      // uploading a folder discovers at file 900 of 2000 that one file was too big, with a
      // half-populated workspace and no clear reason. The server enforces the same limit — this
      // check exists to explain the problem up front, not to be the guard.
      const oversized = entries.filter((entry) => entry.file.size > MAX_UPLOAD_BYTES);
      if (oversized.length > 0) {
        setError(oversizedMessage(oversized));
        return;
      }

      // One failure fails the batch: abort the in-flight siblings rather than pressing on and
      // burying the cause under a pile of consequential errors.
      const controller = new AbortController();
      const queue = [...entries];

      // Send one file, waiting out rate-limit pushback rather than failing the batch for it.
      const send = async (entry: PathedFile): Promise<Response> => {
        for (let attempt = 0; ; attempt += 1) {
          const res = await fetch(`${apiBase}/files/upload?path=${encodeURIComponent(entry.path)}`, {
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
          if (!res.ok) throw new Error(`${entry.path} — ${await failureReason(res)}`);
          uploaded += 1;
          if (uploaded === entries.length || uploaded % PROGRESS_STEP === 0) {
            setStatus(`Uploading ${uploaded}/${entries.length}…`);
          }
        }
      };

      try {
        await Promise.all(Array.from({ length: Math.min(CONCURRENCY, entries.length) }, worker));
      } catch (err) {
        controller.abort();
        throw err;
      }
      onUploaded();
    } catch (err) {
      const reason = err instanceof Error ? err.message : "Upload failed.";
      // Say plainly how far it got — unlike the size check above, this batch is partly applied, and
      // implying otherwise would send the user looking for files that are already there.
      setError(
        uploaded === 0
          ? `Nothing was uploaded — ${reason}`
          : `Upload stopped after ${uploaded} of ${entries.length} files — ${reason}`,
      );
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

  return { status, error, uploadFiles, uploadFolder, uploadPathedFiles };
}
