// In-memory store for the agent's task checklist, scoped per workspace.
// Todos are written by the agent's todo_write tool during multi-step tasks and read by the UI to show progress.
// State is not persisted to disk — it resets when the server restarts.
export type TodoStatus = "pending" | "in_progress" | "completed";
export type TodoPriority = "low" | "medium" | "high";

export interface Todo {
  id: string;
  content: string;
  displayText: string;
  status: TodoStatus;
  priority: TodoPriority;
}

const store = new Map<string, Todo[]>();

export function setTodos(workspaceId: string, todos: Todo[]): { old: Todo[]; updated: Todo[] } {
  const old = store.get(workspaceId) ?? [];
  store.set(workspaceId, todos);
  return { old, updated: todos };
}
