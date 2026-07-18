// Coarse throttle for the handful of log lines an unauthenticated caller can trigger at will.
//
// Rejection paths log before the caller has proven anything, so a scanner that keeps hammering an
// endpoint after its rate limit is exhausted generates a line per request forever. Nothing is at
// risk of filling the disk — Docker's json-file driver caps each service at 10 MB x 5 — but the cap
// is the problem: a flood rotates real history out of the window in minutes, which is exactly when
// you want to look at it.
//
// Deliberately *not* a hook on the logger. Every other log line in this app is emitted by code the
// caller cannot drive, and silently collapsing those would cost more than it saves.

type Window = { openedAt: number; suppressed: number; sources: Set<string> };

const windows = new Map<string, Window>();

// Cap on addresses remembered per window. The set exists to answer one question — is this one
// persistent caller or a spread-out campaign — and hitting the cap already answers it. Storing every
// address would hand an attacker the unbounded map this module exists to avoid.
const MAX_TRACKED_SOURCES = 20;

/**
 * Decide whether to emit a throttled log line.
 *
 * Returns `null` when the line should be dropped, or the number of lines this one stands in for
 * (0 on the first emission of a window). Attach that as a `suppressed` field.
 *
 * Key on the event name alone, never the client address: a flood spread across many addresses is
 * the case this exists for, and per-address keys would let it through untouched. That keeps the map
 * bounded by the number of distinct event names — a handful — so it needs no eviction.
 *
 * The count for a window that never sees another event is lost, so a burst that stops mid-window
 * under-reports its tail. Accepted: the point is to bound the flood while it is happening, and a
 * long flood crosses window boundaries and reports each one.
 */
export function throttleLog(event: string, now = Date.now(), windowMs = 10_000): number | null {
  return rotate(event, undefined, now, windowMs)?.suppressed ?? null;
}

/** What a throttled line stands in for: how many were dropped, and who they came from. */
export type ThrottledWindow = {
  suppressed: number;
  /** Distinct addresses seen during the closed window, including the one that was emitted. */
  sources: string[];
  /** True when more than MAX_TRACKED_SOURCES distinct addresses appeared — i.e. it is distributed. */
  sourcesTruncated: boolean;
};

/**
 * Same throttle, but attributing the flood.
 *
 * `throttleLog` alone reduces a burst to a count, which cannot distinguish one persistent guesser
 * from a spread-out campaign — and the caller that happens to open a window is the only address the
 * line names. Use this on paths an unauthenticated caller reaches, where that distinction is the
 * whole point of having the log.
 *
 * Windows are shared with `throttleLog`, so the same event throttles identically whichever function
 * reports it. Returns `null` when the line should be dropped.
 */
export function throttleLogWithSources(
  event: string,
  source: string,
  now = Date.now(),
  windowMs = 10_000,
): ThrottledWindow | null {
  return rotate(event, source, now, windowMs);
}

function rotate(event: string, source: string | undefined, now: number, windowMs: number): ThrottledWindow | null {
  const open = windows.get(event);
  if (!open || now - open.openedAt >= windowMs) {
    const sources = new Set<string>();
    if (source !== undefined) sources.add(source);
    windows.set(event, { openedAt: now, suppressed: 0, sources });
    return {
      suppressed: open ? open.suppressed : 0,
      sources: open ? [...open.sources] : [],
      sourcesTruncated: open ? open.sources.size >= MAX_TRACKED_SOURCES : false,
    };
  }
  open.suppressed += 1;
  if (source !== undefined && open.sources.size < MAX_TRACKED_SOURCES) open.sources.add(source);
  return null;
}

/** Test seam — the map is process-wide, so a test that asserts counts has to start from zero. */
export function resetLogThrottle(): void {
  windows.clear();
}
