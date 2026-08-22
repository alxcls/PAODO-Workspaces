/**
 * The gate every model call passes before it leaves. One bucket per provider+model, because the
 * providers meter per model — measured: 8 codestral calls left mistral-large's quota untouched.
 *
 * Admission is serialized within a bucket. That is not tidiness: six simultaneous requests to a
 * limit-4 model were told remaining=3, 1, 1 and 0, so two callers acting on the same reported
 * `remaining` is a real race, and only a queue plus a local decrement prevents it.
 */
import { globalSingleton } from "../../infra/globalSingleton";
import type { RateLimitSnapshot } from "./rateLimitHeaders";
import { abortableDelay } from "./retryPolicy";

/** Identifies a bucket. Provider alone would merge models that meter separately. */
export interface PacerKey {
  provider: string;
  model: string;
}

/** An admitted call's hold on the bucket. Released exactly once, however the call ends. */
export interface PacerLease {
  /** How long `acquire` blocked. 0 when it admitted immediately. */
  waitedMs: number;
  /** Callers ahead of this one when it joined. 0 when it never queued. */
  queueDepth: number;
  /** Idempotent, like ProviderConcurrency's release — a call can both throw and be abandoned. */
  release(): void;
}

export interface PacerSnapshot extends PacerKey {
  limitRequests?: number;
  limitTokens?: number;
  remainingRequests?: number;
  remainingTokens?: number;
  /** Requests-per-window ceiling inferred from refusals, where the provider never reported one. */
  learnedRequests?: number;
  /** Calls this process has sent inside the window. */
  sendsInWindow: number;
  recoveryMs: number;
  inFlight: number;
  queued: number;
}

/** Told before a wait that is long enough to be worth showing a user. */
export type PacerNotice = (wait: { waitMs: number; queueDepth: number }) => void;

export interface AcquireOptions {
  signal?: AbortSignal;
  /** Called once, before sleeping, when the wait exceeds NOTICE_THRESHOLD_MS. */
  onPaced?: PacerNotice;
}

/** Below this a wait is not worth telling anyone about — it is shorter than the call it precedes. */
export const NOTICE_THRESHOLD_MS = 2_000;

// Waits are clamped into this range. The floor keeps a pathological reading from becoming a spin;
// the ceiling keeps a bad one from parking a run for an hour when the backstop would recover sooner.
const MIN_WAIT_MS = 50;
const MAX_WAIT_MS = 120_000;

// How the learned recovery moves. Growth is fast because a 429 proves we were wrong; decay is slow
// because a clean call only proves we were not *too* wrong, and a raised ceiling is rare.
const RECOVERY_GROWTH = 1.5;
const RECOVERY_DECAY = 0.95;
const MIN_RECOVERY_MS = 1_000;
const MAX_RECOVERY_MS = 90_000;
const INITIAL_RECOVERY_MS = 20_000;

// A reading older than this describes a window that has since turned over, so the pacer stops
// trusting `remaining` and falls back to what it counted itself.
const SNAPSHOT_TTL_MS = 60_000;

/**
 * The window the local ledger measures over. Measured recoveries on mistral-large were 16s and 52s
 * for a limit spelled "per minute", so a full minute is the conservative reading: it sends a little
 * slower than the provider would allow and never guesses high.
 */
const LEDGER_WINDOW_MS = 60_000;

// Once a refusal has taught us a ceiling, edge back up after this many clean sends at it — so a
// ceiling raised on the provider's side is rediscovered instead of capping the run forever.
const CEILING_PROBE_AFTER = 12;

// What to assume a call will cost before anything has told us. Deliberately generous: overestimating
// costs a little throughput, underestimating costs a 429.
const COLD_TOKEN_ESTIMATE = 8_000;
const ESTIMATE_MARGIN = 1.2;

interface Waiter {
  resolve: () => void;
  reject: (err: unknown) => void;
}

/** One call this process sent, as the local ledger remembers it. */
interface Send {
  at: number;
  tokens: number;
}

interface Bucket {
  limitRequests?: number;
  limitTokens?: number;
  remainingRequests?: number;
  remainingTokens?: number;
  resetRequestsAt?: number;
  resetTokensAt?: number;
  /** Most recent provider-confirmed request-window boundary that has already passed. */
  requestsWindowStartedAt?: number;
  /** Most recent provider-confirmed token-window boundary that has already passed. */
  tokensWindowStartedAt?: number;
  retryAt?: number;
  /**
   * What this process has sent inside the window.
   *
   * Load-bearing for Mistral specifically: it reports rate-limit headers on ordinary responses and
   * NONE on streaming ones, and the agent loop streams — so on the one provider that throttles hard
   * enough to matter, `remaining` is never available and this count is all the pacer has.
   */
  sends: Send[];
  /** Ceilings inferred from refusals, for the providers that never state them on a stream. */
  learnedRequests?: number;
  learnedTokens?: number;
  /** When the provider last refused. The baseline for the learned recovery. */
  refusedAt?: number;
  /** Clean sends since the ceiling was last learned, counted towards probing it upwards again. */
  cleanSends: number;
  /** When the fields above were last written from a response. */
  observedAt: number;
  /** When a call was last admitted. What the spacing fallback measures from — `observedAt` would
   *  let a run with no fresh readings send its whole loop back to back. */
  lastSentAt: number;
  /** Learned drain-to-recovery interval, for providers that report no reset. */
  recoveryMs: number;
  /** The provider's own price for the last call. Mistral reports this; it beats any usage figure. */
  lastCost?: number;
  /** The last call's reported token usage, used only where `lastCost` is unavailable. */
  lastUsage?: number;
  /** Admitted but not yet settled. Their spend is not in `remaining` yet. */
  inFlight: number;
  /** True while a caller holds admission rights; others queue behind it. */
  admitting: boolean;
  waiters: Waiter[];
}

function freshBucket(now: number): Bucket {
  // lastSentAt starts far enough back that a cold bucket's first call is never spaced against a
  // send that did not happen.
  return {
    observedAt: now,
    lastSentAt: now - SNAPSHOT_TTL_MS,
    recoveryMs: INITIAL_RECOVERY_MS,
    sends: [],
    cleanSends: 0,
    inFlight: 0,
    admitting: false,
    waiters: [],
  };
}

const keyOf = (key: PacerKey) => `${key.provider}:${key.model}`;

const clampWait = (ms: number) => Math.min(MAX_WAIT_MS, Math.max(MIN_WAIT_MS, Math.ceil(ms)));

/** Jitter so a bucket's waiters, released one at a time, still do not land in lockstep. */
const jitter = (ms: number, random: () => number) => ms * (0.85 + random() * 0.3);

export interface ProviderPacerOptions {
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  random?: () => number;
}

export class ProviderPacer {
  private readonly buckets = new Map<string, Bucket>();
  private readonly now: () => number;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  private readonly random: () => number;

  constructor(options: ProviderPacerOptions = {}) {
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? abortableDelay;
    this.random = options.random ?? Math.random;
  }

  private bucketFor(key: PacerKey): Bucket {
    const id = keyOf(key);
    let bucket = this.buckets.get(id);
    if (!bucket) {
      bucket = freshBucket(this.now());
      this.buckets.set(id, bucket);
    }
    return bucket;
  }

  // What the next call is likely to cost. An agent's context grows slowly and monotonically, so the
  // last real charge plus a margin beats counting tokens over the whole message array every turn.
  private estimate(bucket: Bucket): number {
    return Math.ceil((bucket.lastCost ?? bucket.lastUsage ?? COLD_TOKEN_ESTIMATE) * ESTIMATE_MARGIN);
  }

  /**
   * Wait until this call may be sent, then reserve its share of the bucket.
   *
   * The returned lease must be released however the call ends — the gateway does it in a `finally`.
   * Rejects with the signal's reason if the run is cancelled while queued or sleeping.
   */
  async acquire(key: PacerKey, options: AcquireOptions = {}): Promise<PacerLease> {
    const bucket = this.bucketFor(key);
    const startedAt = this.now();
    const queueDepth = bucket.waiters.length + (bucket.admitting ? 1 : 0);

    /**
     * One caller decides at a time. Everyone else parks here and re-evaluates when the slot reaches
     * them, so a reopened window is not consumed by every waiter at once. The slot is handed over
     * directly rather than cleared and re-taken, which would let an arriving caller jump the queue.
     */
    if (bucket.admitting) await this.queue(bucket, options.signal);
    else bucket.admitting = true;

    try {
      let notified = false;
      for (;;) {
        options.signal?.throwIfAborted();
        const waitMs = this.waitFor(bucket);
        if (waitMs === 0) break;
        if (!notified && waitMs >= NOTICE_THRESHOLD_MS) {
          notified = true;
          options.onPaced?.({ waitMs, queueDepth });
        }
        await this.sleep(clampWait(jitter(waitMs, this.random)), options.signal);
      }
      this.reserve(bucket);
    } finally {
      this.passSlot(bucket);
    }

    return { waitedMs: this.now() - startedAt, queueDepth, release: this.leaseRelease(bucket) };
  }

  // The reservation `reserve` took, given back once. Without this a call that fails in a way the
  // pacer never hears about would hold a slot of the bucket for the life of the process.
  private leaseRelease(bucket: Bucket): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      bucket.inFlight = Math.max(0, bucket.inFlight - 1);
    };
  }

  private queue(bucket: Bucket, signal?: AbortSignal): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (signal?.aborted) return reject(signal.reason);
      const waiter: Waiter = { resolve, reject };
      bucket.waiters.push(waiter);
      // An abandoned waiter must leave the queue, or the bucket stalls behind a run nobody is
      // waiting on any more.
      signal?.addEventListener(
        "abort",
        () => {
          const at = bucket.waiters.indexOf(waiter);
          if (at !== -1) bucket.waiters.splice(at, 1);
          reject(signal.reason);
        },
        { once: true },
      );
    });
  }

  /**
   * Hand the admission slot straight to the next waiter, keeping `admitting` true across the
   * handover. Clearing it first would open a window for a newly arriving caller to take the slot
   * ahead of everyone already queued.
   */
  private passSlot(bucket: Bucket): void {
    const next = bucket.waiters.shift();
    if (next) next.resolve();
    else bucket.admitting = false;
  }

  /** Spend this call's share up front, so a concurrent caller cannot spend it too. */
  private reserve(bucket: Bucket): void {
    const now = this.now();
    bucket.inFlight += 1;
    bucket.lastSentAt = now;
    bucket.sends.push({ at: now, tokens: this.estimate(bucket) });
    bucket.cleanSends += 1;
    if (bucket.remainingRequests !== undefined) {
      bucket.remainingRequests = Math.max(0, bucket.remainingRequests - 1);
    }
    if (bucket.remainingTokens !== undefined) {
      bucket.remainingTokens = Math.max(0, bucket.remainingTokens - this.estimate(bucket));
    }
  }

  /** Forget sends that have aged out of the window; what remains is what still counts against us. */
  private prune(bucket: Bucket, now: number): void {
    const cutoff = now - LEDGER_WINDOW_MS;
    let drop = 0;
    while (drop < bucket.sends.length && bucket.sends[drop].at <= cutoff) drop += 1;
    if (drop > 0) bucket.sends.splice(0, drop);
  }

  /**
   * Advance each provider-owned window independently once its reset passes.
   *
   * Clearing the old `remaining` matters as much as recording the boundary: a later response may
   * publish the NEXT reset without repeating a remaining count, and neither event may resurrect a
   * snapshot or reservation from the window that just closed.
   */
  private rollProviderWindows(bucket: Bucket, now: number): void {
    if (bucket.resetRequestsAt !== undefined && now >= bucket.resetRequestsAt) {
      bucket.requestsWindowStartedAt = Math.max(bucket.requestsWindowStartedAt ?? 0, bucket.resetRequestsAt);
      bucket.resetRequestsAt = undefined;
      bucket.remainingRequests = undefined;
    }
    if (bucket.resetTokensAt !== undefined && now >= bucket.resetTokensAt) {
      bucket.tokensWindowStartedAt = Math.max(bucket.tokensWindowStartedAt ?? 0, bucket.resetTokensAt);
      bucket.resetTokensAt = undefined;
      bucket.remainingTokens = undefined;
    }
  }

  /**
   * How long before this call may go, in ms. Zero means now.
   *
   * The ledger is primary and a reported `remaining` only ever adds pessimism. That ordering is what
   * makes mixed reporting work: Mistral states a ceiling on its 429s but never a `remaining` on a
   * successful stream, so a `remaining` of zero read once would otherwise stick and throttle the
   * bucket forever. Taking the worse of the two instead lets the ledger heal as sends age out, while
   * a fresh reading still accounts for traffic this process cannot see.
   */
  private waitFor(bucket: Bucket): number {
    const now = this.now();
    const estimate = this.estimate(bucket);
    this.prune(bucket, now);
    this.rollProviderWindows(bucket, now);

    const requestCeiling = bucket.limitRequests ?? bucket.learnedRequests;
    const tokenCeiling = bucket.limitTokens ?? bucket.learnedTokens;
    const requestSends = sendsForAxis(bucket.sends, bucket.requestsWindowStartedAt);
    const tokenSends = sendsForAxis(bucket.sends, bucket.tokensWindowStartedAt);
    // Retry-After applies to the response as a whole, even when that response reported no ceilings.
    if (bucket.retryAt !== undefined && bucket.retryAt > now) return bucket.retryAt - now;
    // Nothing has stated a ceiling and nothing has refused us. Send, and learn from what comes back.
    if (requestCeiling === undefined && tokenCeiling === undefined) return 0;

    /**
     * A reading expires two ways: by age, and by its own reset passing — past that instant it
     * describes a window the provider has already rolled over, and believing it would park the run
     * on a limit that no longer exists.
     */
    const fresh = (reset: number | undefined) =>
      (reset === undefined || now < reset) && now - bucket.observedAt < SNAPSHOT_TTL_MS;
    const worse = (
      counted: number,
      ceiling: number | undefined,
      remaining: number | undefined,
      reset: number | undefined,
    ) =>
      fresh(reset) && ceiling !== undefined && remaining !== undefined
        ? Math.max(counted, ceiling - remaining)
        : counted;

    const requestsUsed = worse(requestSends.length, requestCeiling, bucket.remainingRequests, bucket.resetRequestsAt);
    const tokensUsed = worse(sumTokens(tokenSends), tokenCeiling, bucket.remainingTokens, bucket.resetTokensAt);

    /**
     * A context can outgrow the whole per-minute allowance — measured, mistral-medium charges 49k
     * against a 25k ceiling by its twelfth turn. No wait makes room for a call that never fits, so
     * such a call goes out on an empty window and the provider overdraws, which is what it does
     * anyway. Without this the bucket never admits and the run stalls until its deadline.
     */
    const unfittable = tokenCeiling !== undefined && estimate > tokenCeiling;
    const overRequests = requestCeiling !== undefined && requestsUsed >= requestCeiling;
    const overTokens =
      tokenCeiling !== undefined && (unfittable ? tokensUsed > 0 : tokensUsed + estimate > tokenCeiling);
    if (!overRequests && !overTokens) return 0;

    const pressureAt = Math.max(bucket.refusedAt ?? 0, bucket.observedAt);
    const axisWait = (
      reset: number | undefined,
      sends: readonly Send[],
      fits: (sends: readonly Send[]) => boolean,
    ): number => {
      if (reset !== undefined && reset > now) return reset - now;

      // Where our own sends account for the pressure, the ledger knows exactly when a slot frees.
      for (let i = 1; i <= sends.length; i++) {
        if (fits(sends.slice(i))) return Math.max(0, sends[i - 1].at + LEDGER_WINDOW_MS - now);
      }

      // Pressure with no send of ours behind it came from traffic outside this process. Measure the
      // recovery from the evidence rather than from now, or each pass would restart it forever.
      return Math.max(0, pressureAt + bucket.recoveryMs - now);
    };

    const waits: number[] = [];
    if (overRequests && requestCeiling !== undefined) {
      waits.push(axisWait(bucket.resetRequestsAt, requestSends, (sends) => sends.length < requestCeiling));
    }
    if (overTokens && tokenCeiling !== undefined) {
      waits.push(
        axisWait(bucket.resetTokensAt, tokenSends, (sends) =>
          unfittable ? sumTokens(sends) === 0 : sumTokens(sends) + estimate <= tokenCeiling,
        ),
      );
    }
    // Both axes must have room before admission, hence the later of their independent deadlines.
    return Math.max(...waits);
  }

  /**
   * Fold a response's headers back into the bucket.
   *
   * A reading describes the bucket as the provider saw it, which is only the whole truth if nothing
   * else was in flight beside this call. With company it is stale — measured, six concurrent callers
   * were told remaining = 3, 1, 1 and 0 — so the local projection wins and the reading may only
   * lower it. Alone, the reading is adopted outright, which is also how the bucket recovers from the
   * zero that `penalize` writes: clamping forever would leave it permanently empty.
   */
  settle(key: PacerKey, snapshot: RateLimitSnapshot | null): void {
    if (!snapshot) return;
    const bucket = this.bucketFor(key);
    const now = this.now();
    this.rollProviderWindows(bucket, now);

    if (snapshot.limitRequests !== undefined) bucket.limitRequests = snapshot.limitRequests;
    if (snapshot.limitTokens !== undefined) bucket.limitTokens = snapshot.limitTokens;
    if (snapshot.queryCost !== undefined) bucket.lastCost = snapshot.queryCost;
    if (snapshot.resetRequestsAt !== undefined) bucket.resetRequestsAt = snapshot.resetRequestsAt;
    if (snapshot.resetTokensAt !== undefined) bucket.resetTokensAt = snapshot.resetTokensAt;
    if (snapshot.retryAt !== undefined) bucket.retryAt = snapshot.retryAt;

    // Above one because this call's own reservation is still held; anything more is company.
    const contended = bucket.inFlight > 1;
    const fold = (projected: number | undefined, reported: number | undefined) =>
      contended ? pessimistic(projected, reported) : (reported ?? projected);

    bucket.remainingRequests = fold(bucket.remainingRequests, snapshot.remainingRequests);
    bucket.remainingTokens = fold(bucket.remainingTokens, snapshot.remainingTokens);
    bucket.observedAt = now;
  }

  /** The token usage a call reported, for providers that do not price it in a header. */
  observeUsage(key: PacerKey, tokens: number): void {
    if (tokens > 0) this.bucketFor(key).lastUsage = tokens;
  }

  /**
   * Wait out a backoff this pacer handed back.
   *
   * Exposed so every wait the pacing layer imposes goes through one clock, which is what lets a test
   * drive a retry sequence without real time passing.
   */
  wait(ms: number, signal?: AbortSignal): Promise<void> {
    return this.sleep(ms, signal);
  }

  /**
   * How long the caller should wait after a refusal, having recorded that it happened.
   *
   * A refusal is also the only ceiling report some providers ever give: whatever the ledger counted
   * was demonstrably too much, so it becomes the ceiling. Without this the streaming Mistral path
   * would learn nothing at all and go on colliding at the same rate.
   */
  penalize(key: PacerKey, retryAt?: number): number {
    const bucket = this.bucketFor(key);
    const now = this.now();
    this.prune(bucket, now);
    this.rollProviderWindows(bucket, now);
    const requestSends = sendsForAxis(bucket.sends, bucket.requestsWindowStartedAt);
    const tokenSends = sendsForAxis(bucket.sends, bucket.tokensWindowStartedAt);

    // pacedFetch may already have folded a Retry-After/reset header from this refusal into the
    // bucket before the SDK turns the 429 response into an exception. Prefer that provider-owned
    // deadline to our learned guess. An exact deadline needs no jitter here: admission is serialized
    // when callers wake, and waking before Retry-After would only buy another refusal.
    if (retryAt !== undefined) bucket.retryAt = retryAt;
    const responseWideRetry = bucket.retryAt !== undefined && bucket.retryAt > now ? bucket.retryAt : undefined;
    const requestExhausted =
      bucket.remainingRequests !== undefined
        ? bucket.remainingRequests <= 0
        : bucket.limitRequests !== undefined && requestSends.length >= bucket.limitRequests;
    const estimate = this.estimate(bucket);
    const tokenExhausted =
      bucket.remainingTokens !== undefined
        ? bucket.remainingTokens < estimate
        : bucket.limitTokens !== undefined && sumTokens(tokenSends) + estimate > bucket.limitTokens;
    const quotaDeadlines = [
      requestExhausted ? bucket.resetRequestsAt : undefined,
      tokenExhausted ? bucket.resetTokensAt : undefined,
    ].filter((deadline): deadline is number => deadline !== undefined && deadline > now);
    const providerResetAt = responseWideRetry ?? (quotaDeadlines.length ? Math.max(...quotaDeadlines) : undefined);

    /**
     * Needs at least two: a single send of ours cannot have exceeded a ceiling by itself, so that
     * refusal came from traffic we cannot see and teaches us nothing about our own rate. Learning
     * from it would pin the ceiling at one call per window on the first unlucky collision.
     */
    if (bucket.limitRequests === undefined && requestSends.length > 1) {
      const tooMany = requestSends.length;
      bucket.learnedRequests = Math.max(1, Math.min(bucket.learnedRequests ?? tooMany, tooMany) - 1);
      bucket.cleanSends = 0;
    }

    // Deliberately does not write `remaining`. A fabricated zero would outlive the window it
    // described and keep throttling a bucket the ledger already knows has room.
    bucket.refusedAt = now;
    bucket.recoveryMs = Math.min(MAX_RECOVERY_MS, bucket.recoveryMs * RECOVERY_GROWTH);
    return providerResetAt !== undefined
      ? clampWait(providerResetAt - now)
      : clampWait(jitter(bucket.recoveryMs, this.random));
  }

  /**
   * A call that went through after a wait. Ease the backoff, and once enough have gone cleanly,
   * try one more per window than last time — a ceiling raised on the provider's side is otherwise
   * invisible, and the run would stay throttled to the old one until the process restarted.
   */
  reward(key: PacerKey): void {
    const bucket = this.bucketFor(key);
    bucket.recoveryMs = Math.max(MIN_RECOVERY_MS, bucket.recoveryMs * RECOVERY_DECAY);
    if (bucket.learnedRequests !== undefined && bucket.cleanSends >= CEILING_PROBE_AFTER) {
      bucket.learnedRequests += 1;
      bucket.cleanSends = 0;
    }
  }

  snapshot(key: PacerKey): PacerSnapshot {
    const bucket = this.bucketFor(key);
    this.prune(bucket, this.now());
    return {
      ...key,
      sendsInWindow: bucket.sends.length,
      ...(bucket.learnedRequests === undefined ? {} : { learnedRequests: bucket.learnedRequests }),
      ...(bucket.limitRequests === undefined ? {} : { limitRequests: bucket.limitRequests }),
      ...(bucket.limitTokens === undefined ? {} : { limitTokens: bucket.limitTokens }),
      ...(bucket.remainingRequests === undefined ? {} : { remainingRequests: bucket.remainingRequests }),
      ...(bucket.remainingTokens === undefined ? {} : { remainingTokens: bucket.remainingTokens }),
      recoveryMs: bucket.recoveryMs,
      inFlight: bucket.inFlight,
      queued: bucket.waiters.length,
    };
  }
}

const sumTokens = (sends: readonly Send[]) => sends.reduce((total, send) => total + send.tokens, 0);

/**
 * A provider-owned reset is a stronger window boundary than the conservative 60-second ledger.
 * Reservations before the most recently completed boundary no longer consume that quota axis.
 * Keep this filter axis-specific because request and token allowances can reset independently.
 */
function sendsForAxis(sends: readonly Send[], windowStartedAt: number | undefined): readonly Send[] {
  if (windowStartedAt === undefined) return sends;
  return sends.filter((send) => send.at >= windowStartedAt);
}

/** The lower of what we projected and what the provider reported; either may be the only one known. */
function pessimistic(projected: number | undefined, reported: number | undefined): number | undefined {
  if (reported === undefined) return projected;
  if (projected === undefined) return reported;
  return Math.min(projected, reported);
}

export const providerPacer = globalSingleton("agentProviderPacer", () => new ProviderPacer());
