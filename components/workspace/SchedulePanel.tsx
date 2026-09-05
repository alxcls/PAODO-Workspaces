"use client";

// Schedule button for the TopBar's right slot (sibling of HistoryPanel). The calendar icon opens an
// overlay modal to configure this workspace's single recurring agent run: a prompt fired "every N
// minutes/hours/days/weeks" in a chosen IANA timezone, bounded by a start and optional end time.
// Backed by GET/PUT /api/workspaces/:id/schedule.
//
// Structure: SchedulePanel is just the trigger button + open state. ScheduleModal owns all of the
// data/loading/saving logic and renders while mounted (i.e. only while open). Form state is a single
// object edited through `set(key, value)`; Field/LiveToggle keep the markup declarative.

import { useCallback, useEffect, useMemo, useState } from "react";
import { timezoneOffsetMinutes, timezoneOptionLabel } from "@/lib/client/timezoneLabel";
// The entity itself, not a copy of it. lib/schedules/types.ts is dependency-free — no store, no
// luxon — so this panel types its fetch result and its unit picker from the same declaration the
// validator and the scheduler use. The previous local duplicate could disagree with the server
// silently; adding an interval unit now cannot leave this picker behind.
import { INTERVAL_UNITS, type IntervalUnit, type ScheduleEntry } from "@/lib/schedules/types";

interface FormState {
  prompt: string;
  intervalValue: string;
  intervalUnit: IntervalUnit;
  startAt: string;
  endAt: string;
  timezone: string;
  enabled: boolean;
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

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
    if (typeof fn === "function") return fn("timeZone");
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

const endAtForInput = (endAt: string | undefined): string => {
  if (!endAt) return "";
  // Older schedules stored a date-only inclusive bound. Give those a useful value in the new
  // date-time control instead of rendering it blank; 23:59 retains the former end-of-day intent.
  return endAt.length <= 10 ? `${endAt}T23:59` : endAt.slice(0, 16);
};

const toForm = (s: ScheduleEntry): FormState => ({
  prompt: s.prompt,
  intervalValue: String(s.intervalValue),
  intervalUnit: s.intervalUnit,
  startAt: s.startAt.slice(0, 16),
  endAt: endAtForInput(s.endAt),
  timezone: s.timezone,
  enabled: s.enabled,
});

const toPayload = (f: FormState) => ({
  prompt: f.prompt,
  intervalValue: parseInt(f.intervalValue, 10),
  intervalUnit: f.intervalUnit,
  startAt: f.startAt,
  endAt: f.endAt || null,
  timezone: f.timezone,
  enabled: f.enabled,
});

// ---------------------------------------------------------------------------
// Presentational pieces
// ---------------------------------------------------------------------------

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
    <label className={`flex flex-col gap-1.5 min-w-0 ${grow ? "flex-1 min-h-0" : ""}`}>
      <span className="flex items-baseline justify-between gap-2">
        <span className="text-xs font-semibold uppercase tracking-wide text-text-2">{label}</span>
        {hint && <span className="text-2xs text-text-3 normal-case tracking-normal">{hint}</span>}
      </span>
      {children}
    </label>
  );
}

function LiveToggle({ enabled, onToggle }: { enabled: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={enabled}
      aria-label={enabled ? "Live — pause schedule" : "Paused — resume schedule"}
      onClick={onToggle}
      className="shrink-0 flex items-center gap-2.5 h-9 px-1 transition-colors outline-none focus-visible:ring-2 focus-visible:ring-primary-soft"
    >
      <span className={`text-ms font-semibold ${enabled ? "text-primary" : "text-text-2"}`}>
        {enabled ? "Live" : "Paused"}
      </span>
      <span className={`relative w-9 h-5 rounded-full transition-colors ${enabled ? "bg-primary" : "bg-border"}`}>
        <span
          className={`absolute top-0.5 w-4 h-4 rounded-full bg-white shadow-sm transition-all ${enabled ? "left-[18px]" : "left-0.5"}`}
        />
      </span>
    </button>
  );
}

// ---------------------------------------------------------------------------
// Modal
// ---------------------------------------------------------------------------

interface ModalProps {
  workspaceId: string;
  onClose: () => void;
  onStatus: (enabled: boolean) => void;
}

function ScheduleModal({ workspaceId, onClose, onStatus }: ModalProps) {
  const url = `/api/workspaces/${workspaceId}/schedule`;
  const timezoneOptions = useMemo(() => {
    return allTimezones()
      .map((tz) => ({ value: tz, label: timezoneOptionLabel(tz), offset: timezoneOffsetMinutes(tz) }))
      .sort((a, b) => {
        const ao = a.offset ?? Number.POSITIVE_INFINITY;
        const bo = b.offset ?? Number.POSITIVE_INFINITY;
        if (ao !== bo) return ao - bo;
        return a.value.localeCompare(b.value);
      });
  }, []);

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(emptyForm);

  const set = useCallback(<K extends keyof FormState>(key: K, value: FormState[K]) => {
    setForm((f) => ({ ...f, [key]: value }));
  }, []);

  // Load the current schedule on open.
  useEffect(() => {
    let alive = true;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`Failed to load schedule (${res.status})`);
        const s = (await res.json()) as ScheduleEntry | null;
        if (!alive) return;
        if (s) {
          setForm(toForm(s));
          onStatus(s.enabled);
        }
      } catch (err) {
        if (alive) setError(err instanceof Error ? err.message : "Failed to load schedule");
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [url, onStatus]);

  // Dismiss on Escape.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(url, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(toPayload(form)),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `Save failed (${res.status})`);
      }
      const saved = (await res.json()) as ScheduleEntry;
      onStatus(saved.enabled);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save failed");
      setSaving(false);
    }
  };

  return (
    <div
      className="fixed inset-0 bg-[rgba(15,10,30,0.55)] flex items-center justify-center z-[1000] p-4 sm:p-6"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <form
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
              <h2 className="font-semibold text-lg leading-tight text-text m-0">Scheduled run</h2>
              <p className="text-ms text-text-2 m-0 mt-0.5 truncate">
                Send a prompt to this workspace&apos;s agent on a repeating schedule.
              </p>
            </div>
          </div>
          <LiveToggle enabled={form.enabled} onToggle={() => set("enabled", !form.enabled)} />
        </header>

        {/* Body */}
        {loading ? (
          <div className="py-20 grid place-items-center text-sm text-text-3">Loading…</div>
        ) : (
          <div className="flex-1 min-h-0 overflow-auto p-7 flex flex-col gap-6">
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
            <div className="rounded-xl border border-border-soft bg-bg-tint p-5">
              <div className="text-xs font-semibold uppercase tracking-wide text-text-2 mb-4">Parameters</div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-5 gap-y-4">
                <Field label="Repeat every">
                  <div className="flex gap-2.5">
                    <input
                      type="number"
                      min={1}
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
                    value={form.startAt}
                    onChange={(e) => set("startAt", e.target.value)}
                  />
                </Field>

                <Field label="End" hint="optional">
                  <input
                    type="datetime-local"
                    min={form.startAt}
                    className="input input-sm"
                    value={form.endAt}
                    onChange={(e) => set("endAt", e.target.value)}
                  />
                </Field>
              </div>
            </div>
          </div>
        )}

        {/* Footer */}
        <footer className="flex items-center gap-3 px-7 py-4 border-t border-border-soft shrink-0">
          <button type="submit" className="btn btn-primary ml-auto" disabled={saving || loading}>
            {saving ? "Saving…" : "Save"}
          </button>
        </footer>
      </form>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Trigger
// ---------------------------------------------------------------------------

interface Props {
  workspaceId: string;
}

export default function SchedulePanel({ workspaceId }: Props) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(false);
  const close = useCallback(() => setOpen(false), []);

  // Reflect a live schedule on the button without needing the modal opened first: the calendar icon
  // reads purple whenever this workspace has an enabled schedule.
  useEffect(() => {
    let alive = true;
    fetch(`/api/workspaces/${workspaceId}/schedule`)
      .then((res) => (res.ok ? res.json() : null))
      .then((s: ScheduleEntry | null) => {
        if (alive) setActive(Boolean(s?.enabled));
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [workspaceId]);

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

      {open && <ScheduleModal workspaceId={workspaceId} onClose={close} onStatus={setActive} />}
    </>
  );
}
