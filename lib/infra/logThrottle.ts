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
