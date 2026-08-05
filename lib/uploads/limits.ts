// Single source of truth for the upload size limit. The server handler
// (lib/uploads/upload.ts) enforces it; the browser hook (lib/client/hooks/useFileUpload.ts)
// pre-checks the whole selection against it so an oversized file is reported before any bytes
// leave the browser. Two copies of this number would drift and produce the confusing case where
// the UI accepts a file the server then rejects with a 413.
//
// Keep this module free of server-only imports — it is bundled into the client.

/**
 * Per-file ceiling. Uploads stream straight to disk and are never buffered, so this bounds disk
 * use rather than process memory — which is why it can sit far above the container's RAM. There is
 * deliberately no aggregate limit: a folder upload is N independent one-file requests, so a large
 * tree is only ever as demanding as its single largest file.
 */
export const MAX_UPLOAD_BYTES = 1024 * 1024 * 1024; // 1 GB

/** Byte size for limit messages — "1 GB", "734.2 MB", "512 B". */
export function formatBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  // Whole and large values read cleanly as integers ("1 GB", "734 MB"); keep one decimal for the
  // small fractional cases where rounding to "0 MB" would be useless.
  const rounded = Number.isInteger(value) || value >= 10 ? Math.round(value) : Math.round(value * 10) / 10;
  return `${rounded} ${units[unit]}`;
}
