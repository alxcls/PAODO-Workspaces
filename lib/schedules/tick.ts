// How often due schedules are looked for, apart from the scheduler so a description of it needs no timer.
export const DEFAULT_SCHEDULE_TICK_MS = 30_000;

/** The interval this deployment runs at: SCHEDULE_TICK_MS when it is a positive number, else the default. */
export function scheduleTickMs(): number {
  return parseInt(process.env.SCHEDULE_TICK_MS ?? String(DEFAULT_SCHEDULE_TICK_MS), 10) || DEFAULT_SCHEDULE_TICK_MS;
}
