"use client";

import { useEffect, useState, useMemo, Fragment } from "react";
import { useRouter } from "next/navigation";
import TopBar from "@/components/layout/TopBar";
import type { TurnRecord } from "@/lib/infra/usageStore";

function formatTokens(n: number): string {
  if (n === 0) return "—";
  if (n >= 1000) return (n / 1000).toFixed(1) + "K";
  return String(n);
}

function pad(n: number): string { return String(n).padStart(2, "0"); }

function formatDateTime(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}


interface ToolCallRow {
  name: string;
  args: Record<string, unknown>;
  turnTimestamp: string;
}

interface Session {
  sessionId: string;
  workspaceId: string;
  workspaceName: string;
  timestamp: string;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  toolCalls: ToolCallRow[];
}

function groupBySessions(records: TurnRecord[]): Session[] {
  const map = new Map<string, Session>();
  for (const r of records) {
    const existing = map.get(r.sessionId);
    if (existing) {
      existing.inputTokens += r.inputTokens;
      existing.outputTokens += r.outputTokens;
      existing.cachedInputTokens += r.cachedInputTokens;
      existing.toolCalls.push(...r.toolCalls.map((tc) => ({ ...tc, turnTimestamp: r.timestamp })));
      if (r.timestamp < existing.timestamp) existing.timestamp = r.timestamp;
    } else {
      map.set(r.sessionId, {
        sessionId: r.sessionId,
        workspaceId: r.workspaceId,
        workspaceName: r.workspaceName,
        timestamp: r.timestamp,
        inputTokens: r.inputTokens,
        outputTokens: r.outputTokens,
        cachedInputTokens: r.cachedInputTokens,
        toolCalls: r.toolCalls.map((tc) => ({ ...tc, turnTimestamp: r.timestamp })),
      });
    }
  }
  return Array.from(map.values());
}

export default function DashboardPage() {
  const router = useRouter();
  const [records, setRecords] = useState<TurnRecord[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  useEffect(() => {
    fetch("/api/usage")
      .then((r) => r.json())
      .then(setRecords)
      .catch(() => {});
  }, []);

  const workspaces = useMemo(() => {
    const seen = new Map<string, string>();
    for (const r of records) {
      if (!seen.has(r.workspaceId)) seen.set(r.workspaceId, r.workspaceName);
    }
    return Array.from(seen.entries()).map(([id, name]) => ({ id, name }));
  }, [records]);

  const allSelected = selectedIds.size === 0;

  const sessions = useMemo(() => {
    const filtered = allSelected ? records : records.filter((r) => selectedIds.has(r.workspaceId));
    return groupBySessions(filtered);
  }, [records, selectedIds, allSelected]);

  function toggleAll() { setSelectedIds(new Set()); }

  function toggleWorkspace(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleExpand(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <div className="flex flex-col h-screen">
      <TopBar
        left={<span className="font-semibold tracking-[-0.01em] text-[18px] leading-none">Usage</span>}
        right={
          <button className="btn btn-ghost text-[13px] gap-1.5 text-text-2 hover:text-primary" onClick={() => router.push("/")}>
            ← Home
          </button>
        }
      />

      <div className="flex flex-1 min-h-0">
        {/* Workspace filter sidebar */}
        <aside className="w-[200px] flex-none bg-bg-tint border-r border-border p-4 flex flex-col gap-2.5 overflow-y-auto">
          <p className="text-[11px] font-semibold text-text-3 tracking-[.08em] uppercase mb-0.5">Workspaces</p>
          <label className="flex items-center gap-2 cursor-pointer text-[13px]">
            <input type="checkbox" checked={allSelected} onChange={toggleAll} className="accent-primary" />
            <span className={allSelected ? "text-text-1 font-medium" : "text-text-2"}>All</span>
          </label>
          {workspaces.map((ws) => (
            <label key={ws.id} className="flex items-center gap-2 cursor-pointer text-[13px]">
              <input type="checkbox" checked={selectedIds.has(ws.id)} onChange={() => toggleWorkspace(ws.id)} className="accent-primary" />
              <span className={selectedIds.has(ws.id) ? "text-text-1 font-medium" : "text-text-2"} title={ws.name}>
                {ws.name.length > 16 ? ws.name.slice(0, 15) + "…" : ws.name}
              </span>
            </label>
          ))}
        </aside>

        {/* Session table */}
        <main className="flex-1 overflow-auto">
          {sessions.length === 0 ? (
            <div className="flex items-center justify-center h-full text-text-3 text-[13px]">
              No usage data yet. Run an agent to see sessions here.
            </div>
          ) : (
            <table className="w-full text-[13px] border-collapse">
              <colgroup>
                <col className="w-8" />
                <col />
                <col className="w-[15%]" />
                <col className="w-[15%]" />
                <col className="w-[15%]" />
                <col className="w-[15%]" />
                <col className="w-8" />
              </colgroup>
              <thead>
                <tr className="border-b border-border text-[11px] font-semibold text-text-3 tracking-[.06em] uppercase">
                  <th />
                  <th className="text-left px-6 py-3 font-semibold">Workspace</th>
                  <th className="text-left px-6 py-3 font-semibold">Time</th>
                  <th className="text-right px-6 py-3 font-semibold">In ↑</th>
                  <th className="text-right px-6 py-3 font-semibold">Cached ↑</th>
                  <th className="text-right px-6 py-3 font-semibold">Out ↓</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {sessions.map((s) => {
                  const isOpen = expanded.has(s.sessionId);
                  return (
                    <Fragment key={s.sessionId}>
                      <tr className="border-b border-border hover:bg-bg-tint">
                        <td className="text-center pl-4">
                          {s.toolCalls.length > 0 && (
                            <button onClick={() => toggleExpand(s.sessionId)} className="text-[9px] text-text-3 hover:text-text-1 leading-none">
                              {isOpen ? "▼" : "▶"}
                            </button>
                          )}
                        </td>
                        <td className="px-6 py-2.5 text-text-1 font-medium">{s.workspaceName}</td>
                        <td className="px-6 py-2.5 text-text-3">{formatDateTime(s.timestamp)}</td>
                        <td className="px-6 py-2.5 text-right font-mono text-text-1">{formatTokens(s.inputTokens)}</td>
                        <td className="px-6 py-2.5 text-right font-mono text-text-3">{formatTokens(s.cachedInputTokens)}</td>
                        <td className="px-6 py-2.5 text-right font-mono text-text-1">{formatTokens(s.outputTokens)}</td>
                        <td />
                      </tr>
                      {isOpen && s.toolCalls.map((tc, i) => (
                        <tr key={`${s.sessionId}-tc-${i}`} className="border-b border-border bg-bg-tint">
                          <td />
                          <td className="px-6 py-1.5 font-mono text-[12px]">
                            <span className="text-primary">{tc.name}</span>
                            {Object.keys(tc.args).length > 0 && (
                              <span className="text-text-3 ml-2">
                                {Object.entries(tc.args).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join("  ")}
                              </span>
                            )}
                          </td>
                          <td className="px-6 py-1.5 text-text-3">{formatDateTime(tc.turnTimestamp)}</td>
                          <td colSpan={4} />
                        </tr>
                      ))}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          )}
        </main>
      </div>
    </div>
  );
}
