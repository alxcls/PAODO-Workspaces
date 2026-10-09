"use client";

// TopBar button opening this workspace's single scheduled run. SchedulePanel owns the button and the
// shared read (useWorkspaceSchedule); ScheduleModal owns the form while open.

import { useCallback, useEffect, useMemo, useState } from "react";
import { AsyncState } from "@/components/shared/AsyncState";
import { Switch } from "@/components/shared/Switch";
import { useNow } from "@/lib/client/hooks/useNow";
import { useWorkspaceSchedule, type WorkspaceSchedule } from "@/lib/client/hooks/useWorkspaceSchedule";
import { timezoneOffsetLabel, timezoneOffsetMinutes, timezoneOptionLabel } from "@/lib/client/timezoneLabel";
// The server's own entity and recurrence math, so the form and the preview cannot drift from them.
import { toForm, toPayload, scheduleChanges, type FormState } from "@/lib/client/scheduleForm";
import { computeNextRun } from "@/lib/schedules/nextRun";
import { INTERVAL_UNITS, MAX_INTERVAL_VALUE, type IntervalUnit } from "@/lib/schedules/types";

/** How often an open modal re-reads the schedule and moves its next-run preview forward. */
const REFRESH_MS = 30_000;

// --- Pure helpers ------------------------------------------------------------

const browserTz = (): string => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
};

const allTimezones = (): string[] => {
  try {
    const fn = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf;
    if (typeof fn === "function") return [...new Set(["UTC", browserTz(), ...fn("timeZone")])];
  } catch {
    /* fall through */
  }
  return [browserTz(), "UTC"];
};

function nowLocalInput(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const emptyForm = (): FormState => ({
  prompt: "",
  intervalValue: "1",
  intervalUnit: "day",
  startAt: nowLocalInput(),
  endAt: "",
  timezone: browserTz(),
  enabled: false,
});

/** The next run the form would get if saved now — the scheduler's own calculation, or null if none. */
function previewNextRun(f: FormState, now: Date): Date | null {
  const { endAt, ...recurrence } = toPayload(f);
  if (!recurrence.enabled || !Number.isSafeInteger(recurrence.intervalValue)) return null;
  const next = computeNextRun({ ...recurrence, endAt: endAt ?? undefined }, now);
  return next && !Number.isNaN(next.getTime()) ? next : null;
}

/** A run time on the schedule's own clock, like the Start and End fields, with that instant's offset so a DST shift shows. */
function formatRunTime(at: string | Date, timeZone: string): string {
  const date = new Date(at);
  const options: Intl.DateTimeFormatOptions = {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  };
  try {
    const offset = timezoneOffsetLabel(timeZone, date);
    const time = new Intl.DateTimeFormat(undefined, { ...options, timeZone }).format(date);
    return offset ? `${time} (${offset})` : time;
  } catch {
    return new Intl.DateTimeFormat(undefined, options).format(date);
  }
}

// --- Presentational pieces ---------------------------------------------------

const CalendarIcon = () => (
  <svg
    viewBox="0 0 24 24"
    width="16"
    height="16"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <rect x="3" y="4" width="18" height="18" rx="2" />
    <line x1="3" y1="9" x2="21" y2="9" />
    <line x1="8" y1="2" x2="8" y2="6" />
    <line x1="16" y1="2" x2="16" y2="6" />
  </svg>
);

function Field({
  label,
  hint,
  grow,
  children,
}: {
  label: string;
  hint?: string;
  grow?: boolean;
  children: React.ReactNode;
}) {
  return (
    <label className={`flex flex-col gap-1.5 min-w-0 ${grow ? "flex-1 min-h-[200px] shrink-0" : ""}`}>
      <span className="flex items-baseline justify-between gap-2">
        <span className="text-xs font-semibold uppercase tracking-wide text-text-2">{label}</span>
        {hint && <span className="text-2xs text-text-3 normal-case tracking-normal">{hint}</span>}
      </span>
      {children}
    </label>
  );
}

function StatusMark({ ok }: { ok: boolean }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="14"
      height="14"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      role="img"
      aria-label={ok ? "Succeeded" : "Failed"}
      className={ok ? "text-primary" : "text-danger"}
    >
      {ok ? <polyline points="5 12 10 17 19 7" /> : <path d="M6 6l12 12M18 6L6 18" />}
    </svg>
  );
}

function RunTime({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-1.5 text-ms text-text tabular-nums">
      <span>{label} :</span>
      <span className="flex items-center gap-1.5">{children}</span>
    </div>
  );
}

// --- Modal -------------------------------------------------------------------

interface ModalProps {
  schedule: WorkspaceSchedule;
  onClose: () => void;
}

function ScheduleModal({ schedule, onClose }: ModalProps) {
  const storedTimezone = schedule.data?.entry?.timezone;
  const timezoneOptions = useMemo(() => {
    return [...new Set([...allTimezones(), ...(storedTimezone ? [storedTimezone] : [])])]
      .map((tz) => ({ value: tz, label: timezoneOptionLabel(tz), offset: timezoneOffsetMinutes(tz) }))
      .sort((a, b) => {
        const ao = a.offset ?? Number.POSITIVE_INFINITY;
        const bo = b.offset ?? Number.POSITIVE_INFINITY;
        if (ao !== bo) return ao - bo;
        return a.value.localeCompare(b.value);
      });
  }, [storedTimezone]);

  // Seeded from the panel's own read, so a modal opened after the button already knows its state
  // renders the form at once with no loading pass. `null` means that read is still in flight.
  const loaded = useMemo<FormState | null>(
    () => (schedule.data ? (schedule.data.entry ? toForm(schedule.data.entry) : emptyForm()) : null),
    [schedule.data],
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [initialForm] = useState(emptyForm);
  const [draft, setDraft] = useState<Partial<FormState>>({});
  const form = { ...(loaded ?? initialForm), ...draft };
  const dirty = Object.keys(draft).length > 0;
  // Only a first read blocks the form; a refresh keeps showing the last data while it runs.
  const unavailable = schedule.data === null;
  const lastRun = schedule.data?.entry?.lastRun;
  const now = useNow(REFRESH_MS);
  const nextRun = previewNextRun(form, now);

  const set = useCallback(<K extends keyof FormState>(key: K, value: FormState[K]) => {
    setDraft((current) => ({ ...current, [key]: value }));
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !saving) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, saving]);

  const save = async () => {
    if (unavailable || saving) return;
    setSaving(true);
    setError(null);
    try {
      await schedule.save(scheduleChanges(form, draft, Boolean(schedule.data?.entry)));
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save failed");
      setSaving(false);
    }
  };

  return (
    <div
      className="fixed inset-0 bg-[rgba(15,10,30,0.55)] flex items-center justify-center z-[1000] p-4 sm:p-6"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !saving) onClose();
      }}
    >
      <form
        role="dialog"
        aria-modal="true"
        aria-labelledby="schedule-title"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
        className="bg-bg rounded-2xl shadow-[0_24px_60px_rgba(15,10,30,0.35)] border border-border flex flex-col overflow-hidden w-[min(1120px,94vw)] h-[min(700px,90vh)]"
      >
        {/* Header */}
        <header className="flex items-center justify-between gap-4 px-7 py-[18px] border-b border-border-soft shrink-0">
          <div className="flex items-center gap-3.5 min-w-0">
            <span className="grid place-items-center w-10 h-10 rounded-[11px] bg-primary-tint text-primary shrink-0">
              <CalendarIcon />
            </span>
            <div className="min-w-0">
              <h2 id="schedule-title" className="font-semibold text-lg leading-tight text-text m-0">
                Scheduled run
              </h2>
              <p className="text-ms text-text-2 m-0 mt-0.5 truncate">
                Send a prompt to this workspace&apos;s agent on a repeating schedule.
              </p>
            </div>
          </div>
          {/* Rendered only once the schedule has loaded: seeded from emptyForm it would paint Disabled
              and then animate to the loaded state on every open. Mounting it in its final state skips
              that slide (CSS transitions don't fire on the first render). */}
          {!unavailable && (
            <Switch
              checked={form.enabled}
              onChange={(enabled) => set("enabled", enabled)}
              label={form.enabled ? "Enabled" : "Disabled"}
              ariaLabel={form.enabled ? "Enabled — disable schedule" : "Disabled — enable schedule"}
              disabled={saving}
              className="h-9 px-1"
            />
          )}
        </header>

        {/* Body */}
        {unavailable ? (
          <AsyncState
            loading={schedule.loading}
            error={schedule.error}
            onRetry={schedule.reload}
            loadingLabel="Loading schedule…"
            errorLabel="Couldn’t load the schedule."
            loadingDelayMs={0}
            className="flex-1 min-h-0 justify-center p-7"
          />
        ) : (
          <div className="flex-1 min-h-0 overflow-auto px-7 pt-7 pb-6 flex flex-col gap-6">
            {error && (
              <div className="text-ms text-danger bg-danger-soft border border-danger/20 rounded-md px-3 py-2">
                {error}
              </div>
            )}

            {/* Prompt — primary writing surface */}
            <Field label="Prompt" hint="Sent to the agent on every run" grow>
              <textarea
                className="input resize-none leading-[1.55] flex-1 min-h-[160px] text-[15px]"
                placeholder="e.g. Check the RSS feed and summarise any new items into digest.md"
                value={form.prompt}
                onChange={(e) => set("prompt", e.target.value)}
              />
            </Field>

            {/* Parameters — grouped schedule controls */}
            <div className="shrink-0 rounded-xl border border-border-soft bg-bg-tint p-5">
              <div className="text-xs font-semibold uppercase tracking-wide text-text-2 mb-4">Parameters</div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-5 gap-y-4">
                <Field label="Repeat every">
                  <div className="flex gap-2.5">
                    <input
                      type="number"
                      min={1}
                      max={MAX_INTERVAL_VALUE}
                      step={1}
                      className="input input-sm basis-[84px] grow-0 shrink-0 text-center"
                      value={form.intervalValue}
                      onChange={(e) => set("intervalValue", e.target.value)}
                    />
                    <select
                      className="input input-sm flex-1 min-w-0"
                      value={form.intervalUnit}
                      onChange={(e) => set("intervalUnit", e.target.value as IntervalUnit)}
                    >
                      {INTERVAL_UNITS.map((unit) => (
                        <option key={unit} value={unit}>
                          {unit}s
                        </option>
                      ))}
                    </select>
                  </div>
                </Field>

                <Field label="Timezone">
                  <select
                    className="input input-sm"
                    value={form.timezone}
                    onChange={(e) => set("timezone", e.target.value)}
                  >
                    {timezoneOptions.map((tz) => (
                      <option key={tz.value} value={tz.value}>
                        {tz.label}
                      </option>
                    ))}
                  </select>
                </Field>

                <Field label="Start">
                  <input
                    type="datetime-local"
                    className="input input-sm"
                    value={form.startAt.slice(0, 16)}
                    onChange={(e) => set("startAt", e.target.value)}
                  />
                </Field>

                <Field label="End" hint="optional">
                  <input
                    type="datetime-local"
                    min={form.startAt.slice(0, 16)}
                    className="input input-sm"
                    value={form.endAt.slice(0, 16)}
                    onChange={(e) => set("endAt", e.target.value)}
                  />
                </Field>
              </div>
            </div>

            <div className="shrink-0 flex flex-wrap items-center gap-x-10 gap-y-2 px-1">
              <RunTime label="Last run">
                {lastRun ? (
                  <>
                    {formatRunTime(lastRun.at, form.timezone)}
                    <StatusMark ok={lastRun.status === "ok"} />
                  </>
                ) : (
                  "—"
                )}
              </RunTime>
              <RunTime label="Next run">
                {dirty || !schedule.data?.entry
                  ? nextRun
                    ? formatRunTime(nextRun, form.timezone)
                    : "—"
                  : schedule.data.entry.nextRunAt
                    ? formatRunTime(schedule.data.entry.nextRunAt, form.timezone)
                    : "—"}
              </RunTime>
            </div>
          </div>
        )}

        {/* Footer */}
        <footer className="flex items-center gap-3 px-7 py-4 border-t border-border-soft shrink-0">
          <button type="submit" className="btn btn-primary ml-auto" disabled={saving || unavailable}>
            {saving ? "Saving…" : "Save"}
          </button>
        </footer>
      </form>
    </div>
  );
}

// --- Trigger -----------------------------------------------------------------

interface Props {
  workspaceId: string;
}

export default function SchedulePanel({ workspaceId }: Props) {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);

  // One shared read drives the button colour and the modal, so an open shows the form at once.
  // Polled only while the modal is open, where a finished run or a CLI edit should appear.
  const schedule = useWorkspaceSchedule(workspaceId, { pollMs: open ? REFRESH_MS : undefined });
  const active = Boolean(schedule.data?.entry?.enabled);

  return (
    <>
      <button
        type="button"
        title="Scheduled run"
        aria-label="Scheduled run"
        aria-expanded={open}
        onClick={() => setOpen(true)}
        className={`btn btn-ghost btn-sm ${active ? "text-primary bg-primary-tint" : ""}`}
      >
        <CalendarIcon />
        <span>Schedule</span>
      </button>

      {open && <ScheduleModal key={workspaceId} schedule={schedule} onClose={close} />}
    </>
  );
}
