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

type Window = { openedAt: number; suppressed: number };

const windows = new Map<string, Window>();

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
  const open = windows.get(event);
  if (!open || now - open.openedAt >= windowMs) {
    windows.set(event, { openedAt: now, suppressed: 0 });
    return open ? open.suppressed : 0;
  }
  open.suppressed += 1;
  return null;
}

/** Test seam — the map is process-wide, so a test that asserts counts has to start from zero. */
export function resetLogThrottle(): void {
  windows.clear();
}
