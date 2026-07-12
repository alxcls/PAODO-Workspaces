// Timezone-aware recurrence math for workspace schedules.
//
// A schedule recurs "every N minutes/hours/days/weeks" anchored at `startAt`, interpreted in the
// schedule's IANA `timezone`. Day/week intervals are advanced in wall-clock time within that zone
// (via luxon) so "every 1 day at 09:00 Europe/Brussels" keeps 09:00 across DST transitions, rather
// than drifting by an hour as fixed-millisecond arithmetic would.
import { DateTime } from "luxon";
import type { ScheduleEntry } from "./scheduleStore";

const LUXON_UNIT = {
  minute: "minutes",
  hour: "hours",
  day: "days",
  week: "weeks",
} as const;

// Approximate ms per unit — used only to fast-forward past a long-elapsed anchor before a short
// exact adjustment loop. Real advancement always uses luxon's zone-aware .plus().
const APPROX_MS = {
  minute: 60_000,
  hour: 3_600_000,
  day: 86_400_000,
  week: 604_800_000,
} as const;

/**
 * The first occurrence strictly after `after`, or `null` if the schedule is invalid or has passed
 * its `endAt` bound. If `startAt` is itself after `after`, that first anchor is returned.
 */
export function computeNextRun(entry: ScheduleEntry, after: Date): Date | null {
  if (entry.intervalValue < 1) return null;

  const zone = entry.timezone;
  const luxonUnit = LUXON_UNIT[entry.intervalUnit];
  const start = DateTime.fromISO(entry.startAt, { zone });
  if (!start.isValid) return null;

  const afterDt = DateTime.fromJSDate(after).setZone(zone);

  let dt = start;
  if (dt <= afterDt) {
    // Fast-forward by an estimated whole number of intervals, then correct exactly. The correction
    // loop runs at most a couple of times (only to absorb DST offset changes).
    const stepMs = APPROX_MS[entry.intervalUnit] * entry.intervalValue;
    const n = Math.floor((afterDt.toMillis() - dt.toMillis()) / stepMs);
    if (n > 0) dt = dt.plus({ [luxonUnit]: n * entry.intervalValue });
    while (dt <= afterDt) dt = dt.plus({ [luxonUnit]: entry.intervalValue });
  }

  if (entry.endAt) {
    // A date-only end ("2026-08-13") is inclusive of that whole day in the schedule's zone.
    const raw = DateTime.fromISO(entry.endAt, { zone });
    if (raw.isValid) {
      const endBound = entry.endAt.length <= 10 ? raw.endOf("day") : raw;
      if (dt >= endBound) return null;
    }
  }

  return dt.toJSDate();
}

/** True when the schedule's IANA timezone is recognised by the runtime. */
export function isValidTimezone(tz: string): boolean {
  return DateTime.local().setZone(tz).isValid;
}
