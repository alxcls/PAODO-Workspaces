/**
 * How long a rate-limited call may keep trying. The pacer decides *when* to send; this decides when
 * to stop believing that waiting will help.
 *
 * The cumulative cap is the guard against a refusal that does not clear in a useful amount of time.
 * Better a clear failure after a bounded wait than a call that hangs until the workspace deadline.
 */

/** Attempts for one logical call, first included. */
export const MAX_ATTEMPTS = 8;

/** Total time one call may spend waiting across all its attempts. */
export const MAX_CUMULATIVE_WAIT_MS = 10 * 60_000;

export class RateLimitExhaustedError extends Error {
  readonly code = "RATE_LIMIT_EXHAUSTED" as const;

  constructor(
    readonly provider: string,
    readonly model: string,
    readonly attempts: number,
    readonly waitedMs: number,
    readonly cause: unknown,
  ) {
    super(
      `${provider} kept rate-limiting ${model} for ${Math.round(waitedMs / 1000)}s across ${attempts} attempts. ` +
        `This call stopped after reaching its rate-limit retry budget.`,
    );
    this.name = "RateLimitExhaustedError";
  }
}

/** Tracks one logical call's retry budget across attempts. */
export class RetryBudget {
  private attempts = 0;
  private waited = 0;

  constructor(
    private readonly maxAttempts: number = MAX_ATTEMPTS,
    private readonly maxWaitMs: number = MAX_CUMULATIVE_WAIT_MS,
  ) {}

  /** Counted before each attempt leaves, so `attemptsMade` is honest even mid-flight. */
  startAttempt(): void {
    this.attempts += 1;
  }

  /**
   * Whether to wait `ms` and try again, given what has already been spent. False means give up —
   * either the attempt count is used up, or waiting again would breach the cumulative cap.
   */
  canRetry(ms: number): boolean {
    return this.attempts < this.maxAttempts && this.waited + ms <= this.maxWaitMs;
  }

  recordWait(ms: number): void {
    this.waited += ms;
  }

  get attemptsMade(): number {
    return this.attempts;
  }

  get waitedMs(): number {
    return this.waited;
  }
}

/**
 * A delay that a run's abort cuts short rather than outliving.
 *
 * Deliberately NOT unref'd, unlike the run timer. This wait is work in progress — a call queued for
 * its turn on the provider — so it must hold the event loop open; unref'ing it lets a process with
 * nothing else pending exit in the middle of a paced run. The abort listener is what bounds it.
 */
export function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      reject(signal?.reason);
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
