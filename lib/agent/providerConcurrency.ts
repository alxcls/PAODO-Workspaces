// In-flight calls per provider, counted once for the whole process. Keys are deployment-wide, so
// every run and sub-agent shares one quota — a per-run counter would multiply any ceiling by fan-out.
import { globalSingleton } from "../infra/globalSingleton";

export interface ProviderConcurrencySnapshot {
  provider: string;
  /** Calls in flight at this instant. */
  active: number;
  /** Highest `active` seen for this provider since the process started. */
  peak: number;
  /** Calls entered since the process started, in flight or not. */
  total: number;
}

export interface ProviderConcurrencyGate {
  enter(provider: string): () => void;
  snapshot(provider: string): ProviderConcurrencySnapshot;
  all(): ProviderConcurrencySnapshot[];
}

interface Counters {
  active: number;
  peak: number;
  total: number;
}

/** Measurement only — `enter` never blocks and never refuses. Pacing is a later, separate decision. */
export class ProviderConcurrency implements ProviderConcurrencyGate {
  private readonly counters = new Map<string, Counters>();

  private countersFor(provider: string): Counters {
    let entry = this.counters.get(provider);
    if (!entry) {
      entry = { active: 0, peak: 0, total: 0 };
      this.counters.set(provider, entry);
    }
    return entry;
  }

  // The returned release is idempotent: a stream that both throws and gets abandoned would otherwise
  // decrement twice and leave `active` reading below the truth for the rest of the process.
  enter(provider: string): () => void {
    const entry = this.countersFor(provider);
    entry.active += 1;
    entry.total += 1;
    if (entry.active > entry.peak) entry.peak = entry.active;

    let released = false;
    return () => {
      if (released) return;
      released = true;
      entry.active = Math.max(0, entry.active - 1);
    };
  }

  snapshot(provider: string): ProviderConcurrencySnapshot {
    return { provider, ...this.countersFor(provider) };
  }

  all(): ProviderConcurrencySnapshot[] {
    return [...this.counters.entries()].map(([provider, counters]) => ({ provider, ...counters }));
  }
}

export const providerConcurrency = globalSingleton("agentProviderConcurrency", () => new ProviderConcurrency());
