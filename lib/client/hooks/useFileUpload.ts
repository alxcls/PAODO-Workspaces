"use client";

import { useRef, useState } from "react";

/** A file paired with its intended path inside the workspace (folder uploads keep structure). */
export interface PathedFile {
  file: File;
  path: string;
}

/**
 * Shared upload logic for the file tree panel — used by both the Files/Folder buttons and
 * the drag-and-drop zone. Single files are POSTed individually; anything with folder
 * structure is zipped client-side and sent as one archive (see uploadPathedFiles).
 */
export function useFileUpload(apiBase: string, onUploaded: () => void) {
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Authoritative "one upload at a time" guard. A ref is synchronous and render-independent,
  // so a second call in the same tick — or during the await import("jszip") gap below — is
  // rejected immediately, unlike the status state which only reflects after a re-render.
  const inFlight = useRef(false);

  // Single files: send individually (small count, no need to archive).
  const uploadFiles = async (files: File[]) => {
    if (files.length === 0) return;
    if (inFlight.current) return;
    inFlight.current = true;
    setError(null);
    setStatus("Uploading…");
    try {
      const CONCURRENCY = 5;
      const queue = [...files];
      const worker = async () => {
        while (queue.length > 0) {
          const file = queue.shift()!;
          const res = await fetch(`${apiBase}/files/upload?path=${encodeURIComponent(file.name)}`, {
            method: "POST",
            body: file,
          });
          if (!res.ok) throw new Error(`Failed to upload ${file.name}`);
        }
      };
      await Promise.all(Array.from({ length: Math.min(CONCURRENCY, files.length) }, worker));
      onUploaded();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setStatus(null);
      inFlight.current = false;
    }
  };

  // Folder / mixed: pack everything into a single ZIP then POST once — avoids per-file request
  // storms that exhaust the rate limit and file-descriptor pool for 10k+ file trees.
  const uploadPathedFiles = async (entries: PathedFile[]) => {
    if (entries.length === 0) return;
    if (inFlight.current) return;
    inFlight.current = true;
    setError(null);
    // Set synchronously so the busy styling engages during the dynamic import below,
    // rather than the panel appearing idle until compression starts.
    setStatus("Preparing…");
    try {
      // Loaded on demand — jszip is only needed for folder uploads, so keep it out of the
      // initial workspace bundle (see the lazy FileViewer note in the workspace page).
      const { default: JSZip } = await import("jszip");
      const zip = new JSZip();
      for (const { file, path } of entries) {
        zip.file(path, file);
      }
      setStatus("Compressing 0%");
      const blob = await zip.generateAsync(
        { type: "blob", compression: "DEFLATE", compressionOptions: { level: 1 } },
        (meta) => setStatus(`Compressing ${Math.round(meta.percent)}%`),
      );
      setStatus("Uploading archive…");
      const res = await fetch(`${apiBase}/files/upload`, {
        method: "POST",
        headers: { "Content-Type": "application/zip" },
        body: blob,
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error((body as { error?: string }).error ?? `Upload failed (${res.status})`);
      }
      onUploaded();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setStatus(null);
      inFlight.current = false;
    }
  };

  // <input webkitdirectory> yields flat File[] with webkitRelativePath carrying the structure.
  const uploadFolder = (files: File[]) =>
    uploadPathedFiles(files.map((file) => ({ file, path: file.webkitRelativePath || file.name })));

  return { status, error, uploadFiles, uploadFolder, uploadPathedFiles };
}
