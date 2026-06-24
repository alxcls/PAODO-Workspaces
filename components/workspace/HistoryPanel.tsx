"use client";

// Version-history button for the TopBar's right slot. Clicking the clock icon opens a floating
// panel listing every snapshot as one line — short sha + timestamp — from
// GET /api/workspaces/:id/history. Clicking a line rolls the workspace back to that commit via
// POST /api/workspaces/:id/restore (the hard reset overwrites the work-tree). onRestored() lets
// the page refresh the file tree/viewer to reflect the reverted files.

import { useState, useEffect, useRef, useCallback } from "react";

interface Commit {
  sha: string;
  timestamp: string;
  /** True for the snapshot the workspace is currently at — highlighted in the list. */
  current?: boolean;
}

const ClockIcon = () => (
  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="9" /><polyline points="12 7 12 12 15 14" />
  </svg>
);

function formatTime(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  return d.toLocaleString("en-US", {
    month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
  });
}

interface Props {
  workspaceId: string;
  /** Bump to refetch the log while the panel is open (e.g. when an agent run completes). */
  refreshKey?: number;
  /** Called after a successful restore so the page can refresh the tree/viewer. */
  onRestored?: () => void;
}

export default function HistoryPanel({ workspaceId, refreshKey, onRestored }: Props) {
  const [open, setOpen] = useState(false);
  const [commits, setCommits] = useState<Commit[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [restoring, setRestoring] = useState<string | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);

  const fetchHistory = useCallback(async () => {
    setError(null);
    try {
      const res = await fetch(`/api/workspaces/${workspaceId}/history`);
      if (!res.ok) throw new Error(`Failed to load history (${res.status})`);
      const body = (await res.json()) as { commits: Commit[] };
      setCommits(body.commits ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load history");
    }
  }, [workspaceId]);

  // Refetch whenever the panel opens, and whenever a run completes while it's open.
  useEffect(() => {
    if (open) fetchHistory();
  }, [open, refreshKey, fetchHistory]);

  // Dismiss on outside click / Escape.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => { window.removeEventListener("mousedown", onDown); window.removeEventListener("keydown", onKey); };
  }, [open]);

  const restore = async (sha: string) => {
    setRestoring(sha);
    setError(null);
    try {
      const res = await fetch(`/api/workspaces/${workspaceId}/restore`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sha }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error((body as { error?: string }).error ?? `Restore failed (${res.status})`);
      }
      onRestored?.();
      await fetchHistory();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Restore failed");
    } finally {
      setRestoring(null);
    }
  };

  return (
    <div className="relative" ref={wrapRef}>
      <button
        type="button"
        title="Version history"
        aria-label="Version history"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className={`btn btn-ghost btn-sm ${open ? "bg-black/[.06]" : ""}`}
      >
        <ClockIcon /><span>History</span>
      </button>

      {open && (
        <div className="absolute right-0 top-[calc(100%+6px)] z-50 w-[200px] max-h-[70vh] flex flex-col rounded-[10px] border border-border bg-bg shadow-lg overflow-hidden">
          {error && <div className="text-xs text-danger px-3 py-2 border-b border-border">{error}</div>}

          <div className="flex-1 overflow-auto">
            {commits.length === 0 && !error && (
              <div className="text-xs text-text-3 px-3 py-4 text-center">No snapshots yet.</div>
            )}
            {commits.map((c) => {
              const isRestoring = restoring === c.sha;
              // The current snapshot (HEAD) is just colour-highlighted so you can see where you
              // are; every row is clickable to jump to that snapshot.
              return (
                <button
                  key={c.sha}
                  type="button"
                  onClick={() => restore(c.sha)}
                  disabled={isRestoring}
                  className={`flex items-center gap-2 w-full text-left px-2.5 py-2 text-[12.5px] border-b border-border last:border-b-0 disabled:opacity-50 ${
                    c.current ? "bg-primary/10" : "hover:bg-black/[.03]"
                  }`}
                >
                  <code className={c.current ? "text-primary" : "text-text-2"}>{c.sha.slice(0, 7)}</code>
                  <span className="text-text-3 whitespace-nowrap">{formatTime(c.timestamp)}</span>
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
