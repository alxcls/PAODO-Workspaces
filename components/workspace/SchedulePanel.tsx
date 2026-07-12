"use client";

// Schedule button for the TopBar's right slot (sibling of HistoryPanel). The calendar icon opens an
// overlay modal to configure this workspace's single recurring agent run: a prompt fired "every N
// minutes/hours/days/weeks" in a chosen IANA timezone, bounded by a start and optional end date.
// Backed by GET/PUT/DELETE /api/workspaces/:id/schedule.

import { useState, useEffect, useCallback } from "react";

type IntervalUnit = "minute" | "hour" | "day" | "week";

interface Schedule {
  id: string;
  prompt: string;
  intervalValue: number;
  intervalUnit: IntervalUnit;
  startAt: string;
  endAt?: string;
  timezone: string;
  enabled: boolean;
  nextRunAt: string | null;
  lastRunAt?: string;
  lastRunStatus?: "ok" | "error";
  lastRunSnippet?: string;
}

const CalendarIcon = () => (
  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <rect x="3" y="4" width="18" height="18" rx="2" /><line x1="3" y1="9" x2="21" y2="9" />
    <line x1="8" y1="2" x2="8" y2="6" /><line x1="16" y1="2" x2="16" y2="6" />
  </svg>
);

const browserTz = () => {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"; } catch { return "UTC"; }
};

const allTimezones = (): string[] => {
  try {
    const fn = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf;
    if (typeof fn === "function") return fn("timeZone");
  } catch { /* fall through */ }
  return [browserTz(), "UTC"];
};

function nowLocalInput(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function formatTime(iso?: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "—";
  return d.toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

interface Props {
  workspaceId: string;
}

export default function SchedulePanel({ workspaceId }: Props) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [existing, setExisting] = useState<Schedule | null>(null);

  const [prompt, setPrompt] = useState("");
  const [intervalValue, setIntervalValue] = useState("1");
  const [intervalUnit, setIntervalUnit] = useState<IntervalUnit>("day");
  const [startAt, setStartAt] = useState(nowLocalInput());
  const [endAt, setEndAt] = useState("");
  const [timezone, setTimezone] = useState(browserTz());
  const [enabled, setEnabled] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/workspaces/${workspaceId}/schedule`);
      if (!res.ok) throw new Error(`Failed to load schedule (${res.status})`);
      const s = (await res.json()) as Schedule | null;
      setExisting(s);
      if (s) {
        setPrompt(s.prompt);
        setIntervalValue(String(s.intervalValue));
        setIntervalUnit(s.intervalUnit);
        setStartAt(s.startAt.slice(0, 16));
        setEndAt(s.endAt ? s.endAt.slice(0, 10) : "");
        setTimezone(s.timezone);
        setEnabled(s.enabled);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load schedule");
    } finally {
      setLoading(false);
    }
  }, [workspaceId]);

  useEffect(() => { if (open) load(); }, [open, load]);

  // Dismiss on Escape.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/workspaces/${workspaceId}/schedule`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt,
          intervalValue: parseInt(intervalValue, 10),
          intervalUnit,
          startAt,
          endAt: endAt || null,
          timezone,
          enabled,
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error((body as { error?: string }).error ?? `Save failed (${res.status})`);
      }
      setExisting(await res.json());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save failed");
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/workspaces/${workspaceId}/schedule`, { method: "DELETE" });
      if (!res.ok) throw new Error(`Delete failed (${res.status})`);
      setExisting(null);
      setOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Delete failed");
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <button
        type="button"
        title="Scheduled run"
        aria-label="Scheduled run"
        aria-expanded={open}
        onClick={() => setOpen(true)}
        className={`btn btn-ghost btn-sm ${existing?.enabled ? "text-primary" : ""}`}
      >
        <CalendarIcon /><span>Schedule</span>
      </button>

      {open && (
        <div
          className="fixed inset-0 bg-[rgba(15,10,30,0.55)] flex items-center justify-center z-[1000] p-4"
          onMouseDown={(e) => { if (e.target === e.currentTarget) setOpen(false); }}
        >
          <div className="bg-bg rounded-2xl shadow-[0_18px_40px_rgba(15,10,30,0.25)] w-[min(520px,calc(100vw-32px))] max-h-[calc(100vh-48px)] overflow-auto border border-border p-6">
            <div className="font-semibold text-[19px] mb-1 text-text">Scheduled run</div>
            <p className="text-sm text-text-2 m-0 mb-5 leading-[1.5]">
              Automatically send a prompt to this workspace&apos;s agent on a recurring schedule.
            </p>

            {error && <div className="text-xs text-danger mb-3">{error}</div>}
            {loading ? (
              <div className="text-sm text-text-3 py-6 text-center">Loading…</div>
            ) : (
              <div className="flex flex-col gap-4">
                <label className="flex flex-col gap-1.5">
                  <span className="text-xs font-medium text-text-2">Prompt</span>
                  <textarea
                    className="input resize-none" rows={3}
                    placeholder="e.g. Check the RSS feed and summarise new items"
                    value={prompt} onChange={(e) => setPrompt(e.target.value)}
                  />
                </label>

                <div className="flex items-end gap-2">
                  <label className="flex flex-col gap-1.5">
                    <span className="text-xs font-medium text-text-2">Repeat every</span>
                    <input
                      type="number" min={1} className="input input-sm w-[80px]"
                      value={intervalValue} onChange={(e) => setIntervalValue(e.target.value)}
                    />
                  </label>
                  <label className="flex flex-col gap-1.5 flex-1">
                    <span className="text-xs font-medium text-text-2">&nbsp;</span>
                    <select
                      className="input input-sm" value={intervalUnit}
                      onChange={(e) => setIntervalUnit(e.target.value as IntervalUnit)}
                    >
                      <option value="minute">minutes</option>
                      <option value="hour">hours</option>
                      <option value="day">days</option>
                      <option value="week">weeks</option>
                    </select>
                  </label>
                </div>

                <div className="flex gap-2">
                  <label className="flex flex-col gap-1.5 flex-1">
                    <span className="text-xs font-medium text-text-2">Start</span>
                    <input
                      type="datetime-local" className="input input-sm"
                      value={startAt} onChange={(e) => setStartAt(e.target.value)}
                    />
                  </label>
                  <label className="flex flex-col gap-1.5 flex-1">
                    <span className="text-xs font-medium text-text-2">End (optional)</span>
                    <input
                      type="date" className="input input-sm"
                      value={endAt} onChange={(e) => setEndAt(e.target.value)}
                    />
                  </label>
                </div>

                <label className="flex flex-col gap-1.5">
                  <span className="text-xs font-medium text-text-2">Timezone</span>
                  <select className="input input-sm" value={timezone} onChange={(e) => setTimezone(e.target.value)}>
                    {allTimezones().map((tz) => <option key={tz} value={tz}>{tz}</option>)}
                  </select>
                </label>

                <label className="flex items-center gap-2 cursor-pointer">
                  <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
                  <span className="text-sm text-text">Enabled</span>
                </label>

                {existing && (
                  <div className="text-xs text-text-3 border-t border-border pt-3 flex flex-col gap-1">
                    <div>Next run: <span className="text-text-2">{formatTime(existing.nextRunAt)}</span></div>
                    <div>
                      Last run: <span className="text-text-2">{formatTime(existing.lastRunAt)}</span>
                      {existing.lastRunStatus && (
                        <span className={existing.lastRunStatus === "ok" ? "text-primary ml-1" : "text-danger ml-1"}>
                          ({existing.lastRunStatus})
                        </span>
                      )}
                    </div>
                  </div>
                )}
              </div>
            )}

            <div className="flex gap-2.5 items-center mt-6">
              <button className="btn btn-primary" onClick={save} disabled={saving || loading}>
                {saving ? "Saving…" : "Save"}
              </button>
              {existing && (
                <button className="btn btn-danger" onClick={remove} disabled={saving}>Delete</button>
              )}
              <button className="linkbtn ml-auto" onClick={() => setOpen(false)}>Close</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
