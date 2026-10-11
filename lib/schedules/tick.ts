// How often due schedules are looked for, apart from the scheduler so a description of it needs no timer.
export const DEFAULT_SCHEDULE_TICK_MS = 30_000;

/** The interval this deployment runs at: SCHEDULE_TICK_MS when it is a positive whole number, else the default. */
export function scheduleTickMs(): number {
  const configured = Number(process.env.SCHEDULE_TICK_MS);
  return Number.isInteger(configured) && configured > 0 ? configured : DEFAULT_SCHEDULE_TICK_MS;
}
