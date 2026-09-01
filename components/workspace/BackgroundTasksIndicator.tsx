"use client";

// Ambient TopBar text (sibling of SchedulePanel) that flashes purple while background tasks run in
// the workspace container. Presence signal only — no button, no modal, nothing when idle. Start and
// explicit stop arrive instantly via `poke` (a background_tasks_changed socket push); the poll below
// is only a backstop for a task that exits on its own (which pushes nothing).
import { useCallback, useEffect, useState } from "react";

const POLL_MS = 8000;

export default function BackgroundTasksIndicator({ workspaceId, poke }: { workspaceId: string; poke?: number }) {
  const [commands, setCommands] = useState<string[]>([]);

  const refetch = useCallback(async () => {
    try {
      const res = await fetch(`/api/workspaces/${workspaceId}/background-tasks`);
      if (!res.ok) return;
      const data = (await res.json()) as { tasks: { command: string }[] };
      setCommands((data.tasks ?? []).map((t) => t.command));
    } catch {
      // Transient fetch failures just leave the last known state; the next signal retries.
    }
  }, [workspaceId]);

  // Discover current tasks on mount, on push (poke changes), and when the tab regains focus.
  useEffect(() => {
    const go = () => {
      if (document.visibilityState === "visible") void refetch();
    };
    go();
    document.addEventListener("visibilitychange", go);
    return () => document.removeEventListener("visibilitychange", go);
  }, [refetch, poke]);

  // Backstop poll ONLY while a task is showing — to catch one that exits on its own (no push for
  // that). Idle workspaces poll nothing; a new task arrives via push and restarts this.
  const hasTasks = commands.length > 0;
  useEffect(() => {
    if (!hasTasks) return;
    const tick = () => {
      if (document.visibilityState === "visible") void refetch();
    };
    const timer = setInterval(tick, POLL_MS);
    return () => clearInterval(timer);
  }, [hasTasks, refetch]);

  if (!commands.length) return null;
  const label = `${commands.length} background task${commands.length > 1 ? "s" : ""} running`;
  return (
    <span
      className="font-mono text-[12.5px] leading-[1.4] text-primary-2 px-0.5 select-none"
      title={commands.join("\n")}
    >
      <span className="inline-block w-2 h-2 border-[1.5px] border-primary-2 border-t-transparent rounded-full animate-[tool-spin_0.7s_linear_infinite] align-middle mr-0.5" />{" "}
      <b>{label}</b>
    </span>
  );
}
