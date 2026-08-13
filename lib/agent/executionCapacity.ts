import { AppError } from "@/lib/errors/appError";
import { globalSingleton } from "@/lib/infra/globalSingleton";

export const DEFAULT_MAX_CONCURRENT_AGENT_RUNS = 10;

export interface ExecutionCapacitySnapshot {
  active: number;
  limit: number;
  available: number;
  atCapacity: boolean;
}

export interface ExecutionSlot {
  release(): void;
}

export interface ExecutionCapacityGate {
  tryAcquire(): ExecutionSlot | null;
  snapshot(): ExecutionCapacitySnapshot;
}

export function parseExecutionCapacity(value: string | undefined): number {
  if (value === undefined || value.trim() === "") return DEFAULT_MAX_CONCURRENT_AGENT_RUNS;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_CONCURRENT_AGENT_RUNS;
}

/** Process-wide emergency fuse for active agent loops. */
export class ExecutionCapacity implements ExecutionCapacityGate {
  private active = 0;

  constructor(readonly limit: number) {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("execution capacity must be a positive integer");
  }

  tryAcquire(): ExecutionSlot | null {
    if (this.active >= this.limit) return null;
    this.active += 1;
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        this.active = Math.max(0, this.active - 1);
      },
    };
  }

  snapshot(): ExecutionCapacitySnapshot {
    return {
      active: this.active,
      limit: this.limit,
      available: Math.max(0, this.limit - this.active),
      atCapacity: this.active >= this.limit,
    };
  }
}

export const executionCapacity = globalSingleton(
  "agentExecutionCapacity",
  () => new ExecutionCapacity(parseExecutionCapacity(process.env.MAX_CONCURRENT_AGENT_RUNS)),
);

export function executionCapacityMessage(snapshot: ExecutionCapacitySnapshot): string {
  return (
    `Execution capacity reached: ${snapshot.active}/${snapshot.limit} agent runs are active. ` +
    "This request was not started. Try again when another run finishes."
  );
}

export class ExecutionCapacityReachedError extends AppError {
  constructor(snapshot: ExecutionCapacitySnapshot, details: Record<string, unknown> = {}) {
    super("CAPACITY_REACHED", executionCapacityMessage(snapshot), { ...snapshot, ...details });
    this.name = "ExecutionCapacityReachedError";
  }
}
