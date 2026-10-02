// Timezone-aware recurrence math: day/week steps advance in wall-clock time in the schedule's zone, so
// "every day at 09:00" keeps 09:00 across DST. Pure (luxon + the entity), so server and browser share it.
import { DateTime } from "luxon";
import { MIN_INTERVAL_VALUE, MAX_INTERVAL_VALUE, type ScheduleEntry } from "./types";

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
  if (
    !Number.isSafeInteger(entry.intervalValue) ||
    entry.intervalValue < MIN_INTERVAL_VALUE ||
    entry.intervalValue > MAX_INTERVAL_VALUE ||
    !Object.hasOwn(LUXON_UNIT, entry.intervalUnit)
  )
    return null;

  const zone = entry.timezone;
  const luxonUnit = LUXON_UNIT[entry.intervalUnit];
  const start = DateTime.fromISO(entry.startAt, { zone });
  const afterDt = DateTime.fromJSDate(after).setZone(zone);
  if (!start.isValid || !afterDt.isValid) return null;

  // Calendar candidates always derive from the original wall clock. Advancing an occurrence
  // shifted through a DST gap would otherwise carry its shifted hour into subsequent days.
  const calendar = entry.intervalUnit === "day" || entry.intervalUnit === "week";
  const wall = DateTime.fromISO(entry.startAt, { zone: "UTC" });
  const candidate = (index: number) =>
    calendar
      ? wall.plus({ [luxonUnit]: index * entry.intervalValue }).setZone(zone, { keepLocalTime: true })
      : start.plus({ [luxonUnit]: index * entry.intervalValue });

  let dt: DateTime = start;
  if (dt <= afterDt) {
    const stepMs = APPROX_MS[entry.intervalUnit] * entry.intervalValue;
    let low = 0;
    let high = Math.max(1, Math.ceil((afterDt.toMillis() - start.toMillis()) / stepMs) + 2);
    // Both searches are bounded even for corrupt persisted input or date arithmetic overflow.
    for (let attempt = 0; attempt < 64; attempt++) {
      const upper = candidate(high);
      if (!upper.isValid || upper > afterDt) break;
      high *= 2;
      if (!Number.isSafeInteger(high)) return null;
    }
    for (let attempt = 0; low + 1 < high && attempt < 64; attempt++) {
      const mid = Math.floor((low + high) / 2);
      const value = candidate(mid);
      if (!value.isValid || value > afterDt) high = mid;
      else low = mid;
    }
    dt = candidate(high);
  }
  if (!dt.isValid || dt <= afterDt) return null;

  const end = endBound(entry);
  if (end && dt >= end) return null;

  return dt.toJSDate();
}

/**
 * The instant no run may reach, or null when there is no (readable) end. A date-only end
 * ("2026-08-13") is inclusive of that whole day in the schedule's zone.
 */
export function endBound(entry: Pick<ScheduleEntry, "endAt" | "timezone">): DateTime | null {
  if (!entry.endAt) return null;
  const raw = DateTime.fromISO(entry.endAt, { zone: entry.timezone });
  if (!raw.isValid) return null;
  return entry.endAt.length <= 10 ? raw.endOf("day") : raw;
}

/** The stored `nextRunAt`: on the schedule's clock (`2026-03-29T03:30+02:00`, not `…01:30Z`) so a DST shift reads beside startAt. */
export function nextRunIso(entry: Recurrence & Pick<ScheduleEntry, "enabled">, after: Date): string | null {
  const next = entry.enabled ? computeNextRun(entry, after) : null;
  return (
    next &&
    DateTime.fromJSDate(next, { zone: entry.timezone }).toISO({ suppressMilliseconds: true, suppressSeconds: true })
  );
}

/** True when the schedule's IANA timezone is recognised by the runtime. */
export function isValidTimezone(tz: string): boolean {
  return DateTime.local().setZone(tz).isValid;
}
