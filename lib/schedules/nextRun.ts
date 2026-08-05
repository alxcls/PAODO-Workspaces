// Timezone-aware recurrence math for workspace schedules.
//
// A schedule recurs "every N minutes/hours/days/weeks" anchored at `startAt`, interpreted in the
// schedule's IANA `timezone`. Day/week intervals are advanced in wall-clock time within that zone
// (via luxon) so "every 1 day at 09:00 Europe/Brussels" keeps 09:00 across DST transitions, rather
// than drifting by an hour as fixed-millisecond arithmetic would.
//
// Pure: luxon and the entity shape, nothing else. This is product policy — "when does this fire
// next" is the same answer whether a route, the tick loop, or a test is asking — so it sits beside
// the entity rather than in lib/infra/, which is for talking to the outside world.
import { DateTime } from "luxon";
import { MIN_INTERVAL_VALUE, type ScheduleEntry } from "./types";

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
 * Just the fields the recurrence is derived from. Narrower than ScheduleEntry so a caller can ask
 * "when would this fire?" about a configuration it has validated but not yet given an identity —
 * which is exactly the order lib/operations/schedules/schedule.ts needs. A full entry still
 * satisfies it.
 */
export type Recurrence = Pick<ScheduleEntry, "intervalValue" | "intervalUnit" | "startAt" | "timezone" | "endAt">;

/**
 * The first occurrence strictly after `after`, or `null` if the schedule is invalid or has passed
 * its `endAt` bound. If `startAt` is itself after `after`, that first anchor is returned.
 */
export function computeNextRun(entry: Recurrence, after: Date): Date | null {
  if (entry.intervalValue < MIN_INTERVAL_VALUE) return null;

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
