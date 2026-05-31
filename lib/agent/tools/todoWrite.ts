// Agent tool that replaces the current workspace task checklist with a new list.
// Used during multi-step tasks to track progress — each call overwrites the full list,
// so the agent must always pass all items including completed ones.
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { setTodos } from "../../infra/todoStore";
import type { Todo } from "../../infra/todoStore";

export function buildTodoWriteTool(workspaceId: string) {
  return tool(
    async ({ todos }) => {
      setTodos(workspaceId, todos as Todo[]);
      const statusIcon: Record<string, string> = { completed: "✓", in_progress: "▶", pending: "○" };
      const priorityTag: Record<string, string> = { high: "!", medium: "~", low: " " };
      const lines = todos.map((t) =>
        `${statusIcon[t.status] ?? "○"} [${priorityTag[t.priority] ?? " "}] ${t.status === "in_progress" ? t.displayText : t.content}`
      );
      return lines.join("\n") || "(empty)";
    },
    {
      name: "todo_write",
      description: `Create and manage a task checklist for the current session. Use proactively to track progress on multi-step tasks.

Use when:
- Task requires 3+ distinct steps
- User gives multiple things to do
- You start a step → mark it in_progress BEFORE beginning
- You finish a step → mark it completed immediately

Rules:
- Keep exactly ONE task in_progress at a time
- Always provide both content (imperative: "Fix the bug") and displayText (present continuous: "Fixing the bug")
- Pass the COMPLETE updated list every call — it replaces the current list entirely
- Skip for single trivial tasks`,
      schema: z.object({
        todos: z.array(z.object({
          id: z.string().describe("Unique task ID"),
          content: z.string().describe('Imperative form e.g. "Fix the login bug"'),
          displayText: z.string().describe('Present continuous form e.g. "Fixing the login bug"'),
          status: z.enum(["pending", "in_progress", "completed"]),
          priority: z.enum(["low", "medium", "high"]),
        })).describe("Complete updated todo list — replaces current list"),
      }),
    }
  );
}
