export type LogThrottleDecision =
  | { emit: false }
  | {
      emit: true;
      /** Number of identical events suppressed since the preceding emitted event. */
      suppressed: number;
    };

type State = { lastEmittedAt: number; suppressed: number };

/**
 * Small in-process throttle for repeatable diagnostics. It emits the first event immediately,
 * suppresses repeats for the interval, then attaches the suppressed count to the next event.
 */
export class LogThrottle {
  private readonly states = new Map<string, State>();

  constructor(
    private readonly intervalMs = 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  record(key: string): LogThrottleDecision {
    const now = this.now();
    const state = this.states.get(key);
    if (!state) {
      this.states.set(key, { lastEmittedAt: now, suppressed: 0 });
      return { emit: true, suppressed: 0 };
    }
    if (now - state.lastEmittedAt < this.intervalMs) {
      state.suppressed += 1;
      return { emit: false };
    }
    const suppressed = state.suppressed;
    state.lastEmittedAt = now;
    state.suppressed = 0;
    return { emit: true, suppressed };
  }

  forget(key: string): void {
    this.states.delete(key);
  }
}

/**
 * Returns the fields to log, or null when this event is being suppressed. Emitted events carry a
 * `suppressed` count so a throttled burst still reports its true volume.
 *
 * Keys are deliberately coarse (the event name, not the client IP): the point is to bound how much
 * synchronous durable-log I/O an unauthenticated caller can force, and a per-IP key bounds nothing
 * once a scan is distributed across addresses.
 */
export function throttleFields(
  throttle: LogThrottle,
  key: string,
  fields: Record<string, unknown>,
): Record<string, unknown> | null {
  const decision = throttle.record(key);
  if (!decision.emit) return null;
  return decision.suppressed > 0 ? { ...fields, suppressed: decision.suppressed } : fields;
}
