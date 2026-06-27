"use client";

import { useEffect, useState, useMemo, useRef, useCallback } from "react";
import { useRouter } from "next/navigation";
import Image from "next/image";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import TopBar from "@/components/layout/TopBar";
import { toolLabel, toolArgSummary } from "@/lib/client/agentTranscript";
import type { LightTurnRecord, TurnRecord, ToolStatus } from "@/lib/workspace/usageStore";

// Tool-outcome dot: green success / red failure. From the caller's view a NEEDS_INPUT call
// didn't return a usable result, so it reads red too (the corrected re-call is the green row).
// The enum keeps needs_input distinct at the data layer in case we ever split it back out.
const STATUS_COLOR: Record<ToolStatus, string> = {
  ok: "bg-select",
  error: "bg-danger",
  needs_input: "bg-danger",
};
const STATUS_TITLE: Record<ToolStatus, string> = {
  ok: "Succeeded",
  error: "Failed",
  needs_input: "Failed — needs input",
};
function StatusDot({ status }: { status: ToolStatus }) {
  return (
    <span
      title={STATUS_TITLE[status]}
      className={`inline-block w-2 h-2 rounded-full flex-none ${STATUS_COLOR[status]}`}
    />
  );
}

// Wrap markdown tables so wide tables scroll instead of overflowing the drawer (matches ChatPanel).
const mdComponents: Components = {
  table: ({ node: _n, ...props }) => <div className="table-wrap"><table {...props} /></div>,
};

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

// One user message ("turn line") = one sessionId, aggregated from the light per-turn records.
interface LightSession {
  sessionId: string;
  conversationId?: string;
  workspaceId: string;
  workspaceName: string;
  timestamp: string;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  toolTotal: number;
}

function groupBySessions(records: LightTurnRecord[]): LightSession[] {
  const map = new Map<string, LightSession>();
  for (const r of records) {
    let s = map.get(r.sessionId);
    if (!s) {
      s = {
        sessionId: r.sessionId,
        conversationId: r.conversationId,
        workspaceId: r.workspaceId,
        workspaceName: r.workspaceName,
        timestamp: r.timestamp,
        inputTokens: 0,
        outputTokens: 0,
        cachedInputTokens: 0,
        toolTotal: 0,
      };
      map.set(r.sessionId, s);
    }
    s.inputTokens += r.inputTokens;
    s.outputTokens += r.outputTokens;
    s.cachedInputTokens += r.cachedInputTokens;
    s.toolTotal += r.toolCalls.length;
    if (r.timestamp < s.timestamp) s.timestamp = r.timestamp;
  }
  // Order by when each session STARTED (newest first) — see the agent-to-agent note: a caller's
  // final relay turn is its last record, so sorting by latest turn would float it above its callee.
  return Array.from(map.values()).sort((a, b) => b.timestamp.localeCompare(a.timestamp));
}

// A tool execution located within the fetched session detail (which turn, which call).
interface ToolRef { turnIdx: number; toolIdx: number; }

// Right-side detail drawer. Turn mode (selected === null) shows the user input + a list of every
// tool execution in the session. Clicking a tool switches to tool mode: reasoning + args + output.
function DetailDrawer({ session, onClose, width }: { session: LightSession; onClose: () => void; width: number }) {
  const [detail, setDetail] = useState<TurnRecord[] | null>(null);
  const [selected, setSelected] = useState<ToolRef | null>(null);

  // The drawer is remounted per session (keyed on sessionId by the parent), so state starts
  // fresh — the effect only loads the detail.
  useEffect(() => {
    fetch(`/api/usage/${session.sessionId}`)
      .then((r) => r.json())
      .then(setDetail)
      .catch(() => setDetail([]));
  }, [session.sessionId]);

  const userInput = useMemo(() => detail?.find((t) => t.userInput)?.userInput ?? "", [detail]);
  // The agent's first reasoning, before any tool runs, is the reasoning of the first turn —
  // the one carrying userInput (iteration 1). Shown as an overview block in turn mode.
  const firstReasoning = useMemo(() => detail?.find((t) => t.userInput)?.reasoningText ?? "", [detail]);
  // The agent's final answer lives on the terminal turn — the one that made no tool calls.
  // A limit-reached run has no such turn (the limit summary emits no usage record), so fall
  // back to the latest turn's prose. detail is chronological, so the last entry is newest.
  const agentResponse = useMemo(
    () => detail?.find((t) => t.toolCalls.length === 0)?.outputText ?? detail?.at(-1)?.outputText ?? "",
    [detail],
  );
  const selTool = selected && detail ? detail[selected.turnIdx]?.toolCalls[selected.toolIdx] : null;
  const selReasoning = selected && detail ? detail[selected.turnIdx]?.reasoningText : undefined;

  return (
    <aside className="flex-none bg-bg flex flex-col min-h-0" style={{ width, minWidth: 320 }}>
      <div className="flex items-center justify-between px-5 h-[45px] flex-none border-b border-border">
        <span className="font-semibold text-sm text-text-1 truncate flex items-center gap-2">
          {selected && selTool && <StatusDot status={selTool.status} />}
          {selected ? toolLabel(selTool?.name ?? "") : session.workspaceName}
        </span>
        <button onClick={onClose} className="text-text-3 hover:text-text-1 text-[16px] leading-none">×</button>
      </div>

      {!detail ? (
        <div className="flex-1 flex items-center justify-center text-text-3 text-ms">Loading…</div>
      ) : selected && selTool ? (
        // ── tool mode ───────────────────────────────────────────────────────────────
        <div className="flex-1 overflow-auto px-5 py-4 flex flex-col gap-4">
          <button onClick={() => setSelected(null)} className="text-xs text-primary self-start hover:underline">← back to turn</button>
          {selReasoning && (
            <Section title="Reasoning">
              <p className="text-xs text-text-2 whitespace-pre-wrap leading-relaxed">{selReasoning}</p>
            </Section>
          )}
          <Section title="Input args">
            <pre className="text-xs font-mono text-text-2 whitespace-pre-wrap break-words">{JSON.stringify(selTool.args, null, 2)}</pre>
          </Section>
          <Section title="Output result">
            <pre className="text-xs font-mono text-text-2 whitespace-pre-wrap break-words max-h-[50vh] overflow-auto">{selTool.output || "—"}</pre>
          </Section>
        </div>
      ) : (
        // ── turn mode ───────────────────────────────────────────────────────────────
        <div className="flex-1 overflow-auto px-5 py-4 flex flex-col gap-4">
          <Section title="User input">
            <p className="text-ms text-text-1 whitespace-pre-wrap leading-relaxed">{userInput || "—"}</p>
          </Section>
          <SystemPromptSection workspaceId={session.workspaceId} />
          {firstReasoning && (
            <Section title="Reasoning">
              <p className="text-xs text-text-2 whitespace-pre-wrap leading-relaxed">{firstReasoning}</p>
            </Section>
          )}
          <Section title={`Tool executions (${session.toolTotal})`}>
            {session.toolTotal === 0 ? (
              <p className="text-xs text-text-3">No tool calls in this turn.</p>
            ) : (
              <ul className="flex flex-col gap-1">
                {detail.flatMap((turn, turnIdx) =>
                  turn.toolCalls.map((tc, toolIdx) => (
                    <li key={`${turnIdx}-${toolIdx}`}>
                      <button
                        onClick={() => setSelected({ turnIdx, toolIdx })}
                        className="w-full text-left px-2 py-1.5 rounded transition-colors hover:bg-bg-deep flex items-center gap-2"
                      >
                        <StatusDot status={tc.status} />
                        <span className="flex flex-col min-w-0 flex-1">
                          <span className="text-xs font-mono text-primary">{toolLabel(tc.name)}</span>
                          {toolArgSummary(tc.name, tc.args) && (
                            <span className="text-2xs text-text-3 font-mono truncate">{toolArgSummary(tc.name, tc.args)}</span>
                          )}
                        </span>
                        {/* Same static dim-chevron affordance as the turn rows. */}
                        <span className="flex-none text-text-3 text-sm leading-none opacity-40">›</span>
                      </button>
                    </li>
                  ))
                )}
              </ul>
            )}
          </Section>
          {agentResponse && (
            <Section title="Agent response">
              <div className="md-prose md-drawer text-text-1">
                <ReactMarkdown remarkPlugins={[remarkGfm]} components={mdComponents}>{agentResponse}</ReactMarkdown>
              </div>
            </Section>
          )}
        </div>
      )}
    </aside>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <p className="text-2xs font-semibold text-text-3 tracking-[.06em] uppercase">{title}</p>
      <div className="rounded border border-border bg-bg-tint p-3">{children}</div>
    </div>
  );
}

// Collapsed by default, lazily fetches the workspace's CURRENT system prompt on first expand
// (it isn't stored per turn — see /api/workspaces/[id]/system-prompt). Large, so kept folded.
function SystemPromptSection({ workspaceId }: { workspaceId: string }) {
  const [open, setOpen] = useState(false);
  const [prompt, setPrompt] = useState<string | null>(null);

  useEffect(() => {
    if (!open || prompt !== null) return;
    fetch(`/api/workspaces/${workspaceId}/system-prompt`)
      .then((r) => r.json())
      .then((d) => setPrompt(d.prompt ?? ""))
      .catch(() => setPrompt(""));
  }, [open, prompt, workspaceId]);

  return (
    <div className="flex flex-col gap-1.5">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5 text-2xs font-semibold text-text-3 tracking-[.06em] uppercase hover:text-text-1 transition-colors self-start"
      >
        <span className={`inline-block transition-transform text-sm leading-none ${open ? "rotate-90" : ""}`}>›</span>
        System prompt
      </button>
      {open && (
        <div className="rounded border border-border bg-bg-tint p-3">
          {prompt === null ? (
            <p className="text-xs text-text-3">Loading…</p>
          ) : prompt ? (
            <div className="md-prose md-drawer text-text-1 max-h-[50vh] overflow-auto">
              <ReactMarkdown remarkPlugins={[remarkGfm]} components={mdComponents}>{prompt}</ReactMarkdown>
            </div>
          ) : (
            <p className="text-xs text-text-3">—</p>
          )}
        </div>
      )}
    </div>
  );
}

export default function DashboardPage() {
  const router = useRouter();
  const [records, setRecords] = useState<LightTurnRecord[]>([]);
  const [openSession, setOpenSession] = useState<LightSession | null>(null);
  const [drawerWidth, setDrawerWidth] = useState(440);

  // Drag-to-resize for the detail drawer. The drawer sits on the right edge, so its width is
  // the distance from the cursor to the container's right edge. Mirrors the workspace layout.
  const rowRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!dragging.current || !rowRef.current) return;
      const rect = rowRef.current.getBoundingClientRect();
      // Cap at the container width minus a 240px sliver so the session table never fully collapses.
      setDrawerWidth(Math.max(320, Math.min(rect.width - 240, rect.right - e.clientX)));
    };
    const onUp = () => {
      if (!dragging.current) return;
      dragging.current = false;
      document.body.style.cursor = ""; document.body.style.userSelect = "";
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => { window.removeEventListener("mousemove", onMove); window.removeEventListener("mouseup", onUp); };
  }, []);

  const startDrag = useCallback(() => {
    dragging.current = true;
    document.body.style.cursor = "col-resize"; document.body.style.userSelect = "none";
  }, []);

  const loadUsage = useCallback(() => {
    fetch("/api/usage")
      .then((r) => r.json())
      .then(setRecords)
      .catch(() => {});
  }, []);

  // Load on mount, and again whenever the page is shown after being navigated away from.
  // The session links are full-page <a> navigations, so returning via Back restores the page
  // from the browser's bfcache — React effects don't re-run on that restore, which would leave
  // the stale (empty) render up. `pageshow` fires on bfcache restore; `visibilitychange` covers
  // returning to the tab. Both just refetch the (cheap) light usage list.
  useEffect(() => {
    loadUsage();
    const onPageShow = () => loadUsage();
    const onVisible = () => { if (document.visibilityState === "visible") loadUsage(); };
    window.addEventListener("pageshow", onPageShow);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.removeEventListener("pageshow", onPageShow);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [loadUsage]);

  const sessions = useMemo(() => groupBySessions(records), [records]);

  return (
    <div className="flex flex-col h-screen">
      <TopBar
        left={
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => router.push("/")}
              title="Back to workspaces"
              className="w-[34px] h-[34px] rounded-[10px] overflow-hidden flex-shrink-0 inline-flex items-center justify-center bg-gradient-to-br from-primary to-primary-2 border-0 p-0 cursor-pointer"
            >
              <Image src="/paodo-logo.svg" alt="Paodo logo" width={34} height={34} className="block w-full h-full object-cover" unoptimized />
            </button>
            <span className="font-semibold tracking-[-0.01em] text-lg leading-none inline-flex items-center">
              PAODO WS agents
            </span>
          </div>
        }
      />

      <div className="flex flex-1 min-h-0" ref={rowRef}>
        {/* Session table — each row is one "turn line" (one user message). Click to inspect. */}
        <main className="flex-1 overflow-auto">
          {sessions.length === 0 ? (
            <div className="flex items-center justify-center h-full text-text-3 text-ms">
              No usage data yet. Run an agent to see sessions here.
            </div>
          ) : (
            <table className="w-full text-ms border-separate border-spacing-0 whitespace-nowrap">
              <colgroup>
                <col className="w-[140px]" />
                <col />
                <col className="w-[18%]" />
                <col className="w-[14%]" />
                <col className="w-[14%]" />
                <col className="w-[14%]" />
                <col className="w-[40px]" />
              </colgroup>
              <thead>
                <tr className="border-b border-border text-2xs font-semibold text-text-3 tracking-[.06em] uppercase h-[45px]">
                  <th className="text-left px-6 font-semibold align-middle">Session</th>
                  <th className="text-left px-6 font-semibold align-middle">Workspace</th>
                  <th className="text-left px-6 font-semibold align-middle">Time</th>
                  <th className="text-right px-6 font-semibold align-middle">In ↑</th>
                  <th className="text-right px-6 font-semibold align-middle">Cached ↑</th>
                  <th className="text-right px-6 font-semibold align-middle">Out ↓</th>
                  <th className="w-[40px]" />
                </tr>
              </thead>
              <tbody>
                {sessions.map((s) => (
                  <tr
                    key={s.sessionId}
                    onClick={() => setOpenSession(s)}
                    className={`border-b border-border cursor-pointer transition-colors hover:bg-bg-deep ${openSession?.sessionId === s.sessionId ? "bg-bg-tint" : ""}`}
                  >
                    {/* Session id deep-links to its conversation tab in the callee/UI workspace,
                        matching the call_agent "View conversation" link. stopPropagation so the
                        link navigates instead of opening the detail drawer (the row's click). */}
                    <td className="px-6 py-2.5 font-mono">
                      {s.conversationId ? (
                        <a
                          href={`/workspace/${s.workspaceId}?conversation=${s.conversationId}`}
                          onClick={(e) => e.stopPropagation()}
                          className="text-primary hover:underline"
                          title="Open this session's conversation"
                        >
                          {s.sessionId.slice(0, 8)} ↗
                        </a>
                      ) : (
                        <span className="text-text-3" title="No conversation to link (external agent run)">{s.sessionId.slice(0, 8)}</span>
                      )}
                    </td>
                    <td className="px-6 py-2.5 text-text-1 font-medium">{s.workspaceName}</td>
                    <td className="px-6 py-2.5 text-text-3">{formatDateTime(s.timestamp)}</td>
                    <td className="px-6 py-2.5 text-right font-mono text-text-1">{formatTokens(s.inputTokens)}</td>
                    <td className="px-6 py-2.5 text-right font-mono text-text-3">{formatTokens(s.cachedInputTokens)}</td>
                    <td className="px-6 py-2.5 text-right font-mono text-text-1">{formatTokens(s.outputTokens)}</td>
                    {/* Static dim chevron hints the row opens a detail drawer; the row's bg tint is the hover cue. */}
                    <td className="px-4 py-2.5 align-middle text-right text-text-3 text-[15px] leading-none opacity-40">›</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </main>

        {openSession && (
          <>
            <div className="ws-divider" onMouseDown={startDrag} />
            <DetailDrawer key={openSession.sessionId} session={openSession} onClose={() => setOpenSession(null)} width={drawerWidth} />
          </>
        )}
      </div>
    </div>
  );
}
