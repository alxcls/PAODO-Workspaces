/**
 * The concurrency cases here are not hypothetical. Six simultaneous requests to a limit-4 Mistral
 * model were measured returning remaining = 3, 1, 1 and 0 — two callers told the same number — and
 * two 429s. Every assertion about queueing and pessimistic reconciliation exists because of that.
 */
import { describe, it, expect } from "vitest";
import { ProviderPacer, providerPacer, NOTICE_THRESHOLD_MS } from "./providerPacer";

const LARGE = { provider: "mistral", model: "mistral-large-latest" };
const CODESTRAL = { provider: "mistral", model: "codestral-latest" };
const HAIKU = { provider: "anthropic", model: "claude-haiku-4-5" };

/**
 * A pacer on a clock the test drives: sleeps advance time instead of taking it.
 *
 * The yield before the clock moves matters. A real sleep suspends its caller first, so anything
 * starting in the same tick sees the earlier time; advancing synchronously would hand later callers
 * a clock that had already jumped and hide the queueing this file exists to test.
 */
function testPacer() {
  let clock = 1_700_000_000_000;
  const slept: number[] = [];
  const pacer = new ProviderPacer({
    now: () => clock,
    sleep: async (ms) => {
      await Promise.resolve();
      slept.push(ms);
      clock += ms;
    },
    random: () => 0.5,
  });
  return { pacer, slept, advance: (ms: number) => (clock += ms), at: () => clock };
}

/** Headers as Mistral reports them: ceilings, what is left, and what the last call cost. */
const mistralState = (remainingRequests: number, remainingTokens = 240_000) => ({
  limitRequests: 4,
  remainingRequests,
  limitTokens: 250_000,
  remainingTokens,
  queryCost: 6_416,
});

describe("ProviderPacer — admission", () => {
  it("lets a call straight through when the bucket has room", async () => {
    const { pacer, slept } = testPacer();
    pacer.settle(LARGE, mistralState(3));

    const lease = await pacer.acquire(LARGE);

    expect(lease.waitedMs).toBe(0);
    expect(slept).toEqual([]);
  });

  // The measured 429 case: remaining hits 0 and the next send is guaranteed to be refused, so it
  // must not be sent. Mistral reports no reset, so the wait comes from the learned recovery.
  it("waits instead of sending into an empty bucket", async () => {
    const { pacer, slept } = testPacer();
    pacer.settle(LARGE, mistralState(0));

    const lease = await pacer.acquire(LARGE);

    expect(slept).toHaveLength(1);
    expect(lease.waitedMs).toBeGreaterThan(0);
  });

  // mistral-medium is generous on requests and tight on tokens; a request-only gate would sail past
  // its real ceiling. The estimate comes from the last real charge, not from counting the messages.
  it("waits when the token axis is short even though requests are plentiful", async () => {
    const { pacer, slept } = testPacer();
    pacer.settle(
      { provider: "mistral", model: "mistral-medium-latest" },
      { limitRequests: 50, remainingRequests: 48, limitTokens: 25_000, remainingTokens: 900, queryCost: 6_416 },
    );

    await pacer.acquire({ provider: "mistral", model: "mistral-medium-latest" });

    expect(slept).toHaveLength(1);
  });

  it("uses a reported reset in preference to the learned recovery", async () => {
    const { pacer, slept, at } = testPacer();
    pacer.settle(HAIKU, { limitRequests: 10_000, remainingRequests: 0, resetAt: at() + 4_000 });

    await pacer.acquire(HAIKU);

    // Jittered, so the assertion is about the order of magnitude rather than the exact figure.
    expect(slept[0]).toBeGreaterThan(2_000);
    expect(slept[0]).toBeLessThan(6_000);
  });

  // Anthropic and OpenAI measure 9,999 of 10,000 requests and the full token allowance left. The
  // gate must cost them nothing at all — no sleep, and no notice for a UI to render.
  it("never delays a provider with headroom", async () => {
    const { pacer, slept } = testPacer();
    pacer.settle(HAIKU, {
      limitRequests: 10_000,
      remainingRequests: 9_999,
      limitTokens: 12_000_000,
      remainingTokens: 12_000_000,
    });

    let noticed = false;
    for (let i = 0; i < 20; i++) {
      const lease = await pacer.acquire(HAIKU, { onPaced: () => (noticed = true) });
      lease.release();
      pacer.settle(HAIKU, { remainingRequests: 9_999 - i, remainingTokens: 12_000_000 });
    }

    expect(slept).toEqual([]);
    expect(noticed).toBe(false);
  });
});

describe("ProviderPacer — concurrent callers", () => {
  // The headline case. Without the local decrement every caller reads the same `remaining` and they
  // all send; with it, exactly as many go as the bucket holds and the rest queue.
  it("admits exactly the bucket's worth of six simultaneous callers", async () => {
    const { pacer } = testPacer();
    pacer.settle(LARGE, mistralState(4));

    const leases = await Promise.all(Array.from({ length: 6 }, () => pacer.acquire(LARGE)));

    // All six eventually go — the goal is a slow loop, not a failed one. What matters is that only
    // four went immediately: the other two were made to wait rather than collecting a 429.
    expect(leases).toHaveLength(6);
    expect(leases.filter((l) => l.waitedMs === 0)).toHaveLength(4);
    expect(leases.filter((l) => l.waitedMs > 0)).toHaveLength(2);
  });

  it("tells a queued caller how many are ahead of it", async () => {
    const { pacer } = testPacer();
    pacer.settle(LARGE, mistralState(0));

    const first = pacer.acquire(LARGE);
    const second = pacer.acquire(LARGE);

    expect((await second).queueDepth).toBeGreaterThan(0);
    await first;
  });

  // Buckets are keyed per model because the providers meter per model — 8 codestral calls left
  // mistral-large's quota untouched. Merging them would throttle a model that was never limited.
  it("keeps models apart, so a drained one cannot block a free one", async () => {
    const { pacer, slept } = testPacer();
    pacer.settle(LARGE, mistralState(0));
    pacer.settle(CODESTRAL, { limitRequests: 125, remainingRequests: 124 });

    const lease = await pacer.acquire(CODESTRAL);

    expect(lease.waitedMs).toBe(0);
    expect(slept).toEqual([]);
  });

  // A response is a snapshot of a moment that has already passed. While other calls are out, a late
  // one that read a higher count must not re-admit into a bucket they have since emptied.
  it("never lets a stale reading raise the count while other calls are in flight", async () => {
    const { pacer } = testPacer();
    pacer.settle(LARGE, mistralState(4));

    const held = await pacer.acquire(LARGE);
    const alongside = await pacer.acquire(LARGE);
    expect(pacer.snapshot(LARGE).remainingRequests).toBe(2);

    pacer.settle(LARGE, mistralState(4));
    expect(pacer.snapshot(LARGE).remainingRequests).toBe(2);
    held.release();
    alongside.release();
  });

  /**
   * With nothing else out, the reading is the whole truth and is adopted as-is — including upwards.
   * Clamping to the older projection forever would leave a bucket empty for good, and every later
   * call would wait on a window that had long since reopened.
   */
  it("adopts a reading outright when no other call is in flight", async () => {
    const { pacer } = testPacer();
    pacer.settle(LARGE, mistralState(1));
    const lease = await pacer.acquire(LARGE);
    expect(pacer.snapshot(LARGE).remainingRequests).toBe(0);

    pacer.settle(LARGE, mistralState(3));
    lease.release();

    expect(pacer.snapshot(LARGE).remainingRequests).toBe(3);
    expect(pacer.snapshot(LARGE).remainingTokens).toBe(240_000);
  });

  // A cancelled run must not hold the queue: the next caller would wait on a promise nobody will
  // ever resolve, and the bucket would stall for the life of the process.
  it("lets an aborted waiter out of the queue without stalling the next one", async () => {
    const { pacer } = testPacer();
    pacer.settle(LARGE, mistralState(0));

    const holder = pacer.acquire(LARGE);
    const controller = new AbortController();
    const abandoned = pacer.acquire(LARGE, { signal: controller.signal });
    const follower = pacer.acquire(LARGE);

    controller.abort(new Error("run cancelled"));
    await expect(abandoned).rejects.toThrow(/cancelled/);

    await expect(holder).resolves.toBeDefined();
    await expect(follower).resolves.toBeDefined();
  });

  // Reserved capacity is given back exactly once, however the call ended.
  it("counts a released lease only once", async () => {
    const { pacer } = testPacer();
    pacer.settle(LARGE, mistralState(4));

    const lease = await pacer.acquire(LARGE);
    expect(pacer.snapshot(LARGE).inFlight).toBe(1);
    lease.release();
    lease.release();
    expect(pacer.snapshot(LARGE).inFlight).toBe(0);
  });
});

describe("ProviderPacer — learning", () => {
  // Measured recoveries for the same nominal limit were 16s and 52s, so the interval cannot be
  // assumed. It widens on every refusal and eases back on success, converging on the truth.
  it("widens the backoff each time the provider refuses again", () => {
    const { pacer } = testPacer();

    const first = pacer.penalize(LARGE);
    const second = pacer.penalize(LARGE);
    const third = pacer.penalize(LARGE);

    expect(second).toBeGreaterThan(first);
    expect(third).toBeGreaterThan(second);
  });

  it("eases the recovery back down after a call that had to wait but went through", () => {
    const { pacer } = testPacer();
    pacer.penalize(LARGE);
    const widened = pacer.snapshot(LARGE).recoveryMs;

    pacer.reward(LARGE);

    expect(pacer.snapshot(LARGE).recoveryMs).toBeLessThan(widened);
  });

  /**
   * A refusal must not fabricate a `remaining` of zero. Mistral reports nothing on a successful
   * stream, so an invented zero would never be corrected and would throttle the bucket for good;
   * the ledger and the learned ceiling carry the refusal instead, and they expire on their own.
   */
  it("records a refusal without inventing a remaining count", async () => {
    const { pacer, advance } = testPacer();
    for (let i = 0; i < 4; i++) (await pacer.acquire(LARGE)).release();

    pacer.penalize(LARGE);
    expect(pacer.snapshot(LARGE).remainingRequests).toBeUndefined();
    expect(pacer.snapshot(LARGE).learnedRequests).toBe(3);

    // Once the window has rolled past our own sends, the bucket is usable again with no new reading.
    advance(90_000);
    expect((await pacer.acquire(LARGE)).waitedMs).toBe(0);
  });

  // Nothing has reported a ceiling yet, so there is nothing to pace against. One call goes and
  // teaches us; it must not be held back on a guess.
  it("admits the first call of a cold bucket", async () => {
    const { pacer, slept } = testPacer();

    const lease = await pacer.acquire(LARGE);

    expect(lease.waitedMs).toBe(0);
    expect(slept).toEqual([]);
  });

  // Once a reading is older than the window it describes, `remaining` is fiction and the pacer
  // counts its own sends instead: four fit, the fifth waits for the oldest to age out.
  it("counts its own sends once a reported reading goes stale", async () => {
    const { pacer, slept, advance } = testPacer();
    pacer.settle(LARGE, mistralState(4));
    advance(120_000);

    for (let i = 0; i < 4; i++) expect((await pacer.acquire(LARGE)).waitedMs).toBe(0);
    await pacer.acquire(LARGE);

    expect(slept).toHaveLength(1);
    // The oldest of the four is a whole window old by then, so the wait is nearly the full minute.
    expect(slept[0]).toBeGreaterThan(50_000);
  });

  it("announces a wait long enough to be worth showing, and stays quiet about a short one", async () => {
    const { pacer, at } = testPacer();
    const notices: number[] = [];

    pacer.settle(HAIKU, { limitRequests: 10, remainingRequests: 0, resetAt: at() + 30_000 });
    await pacer.acquire(HAIKU, { onPaced: ({ waitMs }) => notices.push(waitMs) });
    expect(notices).toHaveLength(1);
    expect(notices[0]).toBeGreaterThanOrEqual(NOTICE_THRESHOLD_MS);

    const quiet: number[] = [];
    pacer.settle(CODESTRAL, { limitRequests: 125, remainingRequests: 0, resetAt: at() + 100 });
    await pacer.acquire(CODESTRAL, { onPaced: ({ waitMs }) => quiet.push(waitMs) });
    expect(quiet).toEqual([]);
  });
});

/**
 * Mistral reports rate-limit headers on ordinary responses and NONE on streaming ones — verified
 * against the live API. The agent loop streams, so on the one provider that throttles hard enough to
 * matter the pacer never sees `remaining` and has to work entirely from what it counted itself.
 */
describe("ProviderPacer — no headers at all, as a streaming Mistral call sees it", () => {
  it("sends freely until a refusal, since nothing has stated a ceiling", async () => {
    const { pacer, slept } = testPacer();

    for (let i = 0; i < 6; i++) expect((await pacer.acquire(LARGE)).waitedMs).toBe(0);

    expect(slept).toEqual([]);
    expect(pacer.snapshot(LARGE).sendsInWindow).toBe(6);
  });

  // The refusal is the ceiling report. Four sends were counted and the fifth was refused, so four
  // is too many and the pacer holds itself to three until a probe says otherwise.
  it("learns the ceiling from what it had sent when the provider refused", async () => {
    const { pacer } = testPacer();
    for (let i = 0; i < 4; i++) (await pacer.acquire(LARGE)).release();

    pacer.penalize(LARGE);

    expect(pacer.snapshot(LARGE).learnedRequests).toBe(3);
  });

  it("holds to the learned ceiling afterwards instead of colliding again", async () => {
    const { pacer, slept, advance } = testPacer();
    for (let i = 0; i < 4; i++) (await pacer.acquire(LARGE)).release();
    pacer.penalize(LARGE);
    advance(90_000);

    for (let i = 0; i < 3; i++) expect((await pacer.acquire(LARGE)).waitedMs).toBe(0);
    await pacer.acquire(LARGE);

    expect(slept).toHaveLength(1);
    expect(slept[0]).toBeGreaterThan(0);
  });

  // Waiting only as long as the window actually needs, rather than a fixed interval: with the
  // oldest send already half a minute old, only the remainder of its minute is left to serve.
  it("waits exactly until the oldest send ages out of the window", async () => {
    const { pacer, slept, advance } = testPacer();
    for (let i = 0; i < 4; i++) (await pacer.acquire(LARGE)).release();
    pacer.penalize(LARGE);
    advance(90_000);

    for (let i = 0; i < 3; i++) (await pacer.acquire(LARGE)).release();
    advance(40_000);
    await pacer.acquire(LARGE);

    // 60s window, oldest send 40s ago, so about 20s remain.
    expect(slept[0]).toBeGreaterThan(15_000);
    expect(slept[0]).toBeLessThan(25_000);
  });

  // A support ticket raising the limit must not need a redeploy to take effect.
  it("probes the ceiling upwards after a run of clean sends", async () => {
    const { pacer, advance } = testPacer();
    for (let i = 0; i < 4; i++) (await pacer.acquire(LARGE)).release();
    pacer.penalize(LARGE);
    const learned = pacer.snapshot(LARGE).learnedRequests!;

    for (let i = 0; i < 20; i++) {
      advance(70_000);
      (await pacer.acquire(LARGE)).release();
      pacer.reward(LARGE);
    }

    expect(pacer.snapshot(LARGE).learnedRequests).toBeGreaterThan(learned);
  });

  // A provider that does report a ceiling has said something better than a guess; a refusal caused
  // by someone else's traffic on the same key must not talk us down below it.
  it("leaves a reported ceiling alone rather than inferring over it", async () => {
    const { pacer } = testPacer();
    pacer.settle(LARGE, mistralState(4));
    for (let i = 0; i < 2; i++) (await pacer.acquire(LARGE)).release();

    pacer.penalize(LARGE);

    expect(pacer.snapshot(LARGE).learnedRequests).toBeUndefined();
    expect(pacer.snapshot(LARGE).limitRequests).toBe(4);
  });
});

describe("providerPacer", () => {
  // Sub-agent runs build their own gateway. A per-run pacer would multiply every ceiling by the
  // fan-out, which is the exact failure this exists to prevent.
  it("is one instance for the whole process", () => {
    expect(providerPacer).toBe(
      (global as typeof global & { __singletons: Record<string, unknown> }).__singletons.agentProviderPacer,
    );
  });
});
