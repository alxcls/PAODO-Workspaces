// Trigger-neutral workspace queries. UI routes, CLI-facing routes, MCP adapters, schedules, and
// other entry points should call operations like these instead of reimplementing workspace rules or
// response shapes. Authentication and transport formatting stay at the adapter boundary.
import type { IWorkspaceStore } from "@/lib/infra/interfaces";
import { getStore } from "@/lib/infra/services";
import { DEFAULT_LLM, type ReasoningEffort } from "@/lib/agent/interfaces";
import type { Workspace } from "@/lib/workspace/workspaceStore";

export interface WorkspaceSummary {
  id: string;
  name: string;
  description: string;
}

export interface WorkspaceDetails extends WorkspaceSummary {
  createdAt: Date;
  maxIterations: number;
  maxRunMinutes: number;
  internetAccess: boolean;
  llmProvider: string;
  llmModel: string;
  reasoningEffort: ReasoningEffort;
}

type WorkspaceReader = Pick<IWorkspaceStore, "getWorkspace" | "listWorkspaces">;

function summary(workspace: Workspace): WorkspaceSummary {
  return {
    id: workspace.id,
    name: workspace.name,
    description: workspace.description ?? "",
  };
}

export function listWorkspaces(store: WorkspaceReader = getStore()): WorkspaceSummary[] {
  return store.listWorkspaces().map(summary);
}

export function getWorkspace(id: string, store: WorkspaceReader = getStore()): WorkspaceDetails | null {
  const workspace = store.getWorkspace(id);
  if (!workspace) return null;
  return {
    ...summary(workspace),
    createdAt: workspace.createdAt,
    maxIterations: workspace.maxIterations,
    maxRunMinutes: workspace.maxRunMinutes,
    internetAccess: workspace.internetAccess,
    llmProvider: workspace.llmProvider ?? DEFAULT_LLM.provider,
    llmModel: workspace.llmModel ?? DEFAULT_LLM.model,
    reasoningEffort: workspace.reasoningEffort ?? DEFAULT_LLM.reasoningEffort,
  };
}
