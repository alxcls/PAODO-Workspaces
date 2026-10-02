import type { IntervalUnit, ScheduleEntry } from "@/lib/schedules/types";
import type { SchedulePayload } from "./hooks/useWorkspaceSchedule";

export interface FormState {
  prompt: string;
  intervalValue: string;
  intervalUnit: IntervalUnit;
  startAt: string;
  endAt: string;
  timezone: string;
  enabled: boolean;
}

export const toForm = (s: ScheduleEntry): FormState => ({
  prompt: s.prompt,
  intervalValue: String(s.intervalValue),
  intervalUnit: s.intervalUnit,
  startAt: s.startAt.length <= 10 ? `${s.startAt}T00:00` : s.startAt,
  endAt: s.endAt ?? "",
  timezone: s.timezone,
  enabled: s.enabled,
});

export const toPayload = (f: FormState): SchedulePayload => ({
  prompt: f.prompt,
  intervalValue: Number(f.intervalValue),
  intervalUnit: f.intervalUnit,
  startAt: f.startAt,
  endAt: f.endAt || null,
  timezone: f.timezone,
  enabled: f.enabled,
});

/** Existing jobs send only user-edited fields, retaining untouched wire values verbatim. */
export function scheduleChanges(form: FormState, draft: Partial<FormState>, exists: boolean): Partial<SchedulePayload> {
  const payload = toPayload(form);
  return exists
    ? Object.fromEntries(Object.keys(draft).map((key) => [key, payload[key as keyof SchedulePayload]]))
    : payload;
}
