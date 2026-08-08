// Bounded file-descriptor concurrency for anything that fans out over a workspace tree.
//
// A naive Promise.all over a large tree opens every file at once and hits EMFILE ("too many open
// files"). Where that lands is the reason this is shared rather than local to one caller: in the
// download zip it silently dropped the unreadable files from the archive, and any future
// manifest walk would lose their hashes the same way — a partial answer that looks complete. One
// semaphore, one limit, one place to raise it.
//
// Extracted from zip.ts, which owned it privately, so the tree walker and the archiver share the
// budget rather than each assuming it has the whole process's descriptors to itself.

// Conservative enough to stay under a typical macOS soft limit (ulimit -n 256) while leaving headroom
// for sockets and the rest of the process; still plenty of parallelism to keep the disk busy.
export const MAX_OPEN_FILES = 64;

/**
 * Counting semaphore. Releasing hands the permit straight to the next waiter (without touching the
 * active count) so the in-flight total never exceeds `max`.
 */
export class Semaphore {
  private active = 0;
  private waiters: (() => void)[] = [];
  constructor(private readonly max: number) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.max) {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    } else {
      this.active++;
    }
    try {
      return await fn();
    } finally {
      const next = this.waiters.shift();
      if (next) next();
      else this.active--;
    }
  }
}

/** A semaphore at the shared descriptor budget. One per traversal. */
export function openFileLimiter(): Semaphore {
  return new Semaphore(MAX_OPEN_FILES);
}
