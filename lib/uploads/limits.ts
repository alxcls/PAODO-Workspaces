// Single source of truth for the upload size limit. The server handler
// (lib/uploads/upload.ts) enforces it; the browser hook (lib/client/hooks/useFileUpload.ts)
// pre-checks the whole selection against it so an oversized file is reported before any bytes
// leave the browser. Two copies of this number would drift and produce the confusing case where
// the UI accepts a file the server then rejects with a 413.
//
// Keep this module free of server-only imports — it is bundled into the client.

/**
 * Per-file ceiling, honoured by every path that accepts bytes. Transfers stream straight to disk and
 * are never buffered, so this bounds disk use rather than process memory — which is why it can sit far
 * above the container's RAM.
 *
 * A per-file limit is the *only* limit the browser's upload path needs, because a folder upload there
 * is N independent one-file requests: a large tree is never more demanding than its single largest
 * file. That reasoning does not carry over to the CLI's transfer route, where one request carries a
 * whole tree — hence the two aggregate caps below, which apply only to that path.
 */
export const MAX_UPLOAD_BYTES = 1024 * 1024 * 1024; // 1 GB

/**
 * Entry ceiling for one tar transfer. Per-entry size and free-space checks bound the *bytes* a
 * transfer can land but say nothing about how many inodes it consumes, so an archive of millions of
 * empty files passes every other check and still exhausts the filesystem. The browser path gets this
 * bound for free from the rate limiter, one request per file; a single-request transport has to state
 * it. Set well above a real source tree — the Linux kernel is roughly 80k files — so it refuses abuse
 * rather than work.
 */
export const MAX_TRANSFER_ENTRIES = 100_000;

/**
 * Total ceiling for one tar transfer. Distinct from free space, which is already checked per entry:
 * this bounds how much time and I/O a single request can claim, since the server holds one connection
 * open for the whole transfer (server.ts sets a 30 minute request timeout).
 */
export const MAX_TRANSFER_BYTES = 8 * 1024 * 1024 * 1024; // 8 GB

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
