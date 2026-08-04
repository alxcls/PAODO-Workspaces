// Shared validation bounds for the workspace agent loop. The timeout is stored in minutes because
// that is the unit exposed in the workspace UI; runtime code converts it to milliseconds only when
// a run starts.
export const DEFAULT_MAX_RUN_MINUTES = 5;
export const MIN_MAX_RUN_MINUTES = 1;
export const MAX_MAX_RUN_MINUTES = 1_440;
export const MIN_MAX_ITERATIONS = 1;
export const MAX_MAX_ITERATIONS = 500;

export function normalizeMaxRunMinutes(value: unknown): number {
  const minutes = Math.floor(Number(value));
  return Number.isFinite(minutes) && minutes >= MIN_MAX_RUN_MINUTES && minutes <= MAX_MAX_RUN_MINUTES
    ? minutes
    : DEFAULT_MAX_RUN_MINUTES;
}
