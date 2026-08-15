// Public workspace projections and trigger-neutral queries.
import type { IWorkspaceStore } from "@/lib/infra/interfaces";
import { getStore } from "@/lib/infra/services";
import { defaultModelSelection, getProviderMetadata } from "@/lib/agent/buildModel";
import type { Workspace } from "@/lib/workspace/types";
import type { ModelSelection } from "@/lib/models/selection";

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
  /** Omitted when the selected provider has no reasoning-effort control. */
  reasoningEffort?: ModelSelection["reasoningEffort"];
}

export type PublicModelSelection = {
  llmProvider: string;
  llmModel: string;
  reasoningEffort?: ModelSelection["reasoningEffort"];
};

export type WorkspaceReader = Pick<IWorkspaceStore, "getWorkspace" | "listWorkspaces">;
export type WorkspaceLookup = Pick<IWorkspaceStore, "getWorkspace">;

/**
 * A workspace's stored model choice, with defaults applied for fields it never set. The defaults come
 * from the available catalog, so a workspace that never picked shows and runs a provider .env actually
 * allows. A workspace that DID pick keeps its choice even if that provider is no longer available —
 * withdrawing a provider stops it being offered, it does not rewrite selections already made.
 */
export function currentModelSelection(workspace: Workspace): ModelSelection {
  const fallback = defaultModelSelection();
  return {
    provider: workspace.llmProvider ?? fallback.provider,
    model: workspace.llmModel ?? fallback.model,
    reasoningEffort: workspace.reasoningEffort ?? fallback.reasoningEffort,
  };
}

/** Project the complete internal model tuple onto the public workspace representation. */
export function publicModelSelection(selection: ModelSelection): PublicModelSelection {
  const supportsReasoningEffort = getProviderMetadata(selection.provider).reasoningEfforts.length > 0;
  return {
    llmProvider: selection.provider,
    llmModel: selection.model,
    ...(supportsReasoningEffort ? { reasoningEffort: selection.reasoningEffort } : {}),
  };
}

export function workspaceSummary(workspace: Workspace): WorkspaceSummary {
  return {
    id: workspace.id,
    name: workspace.name,
    description: workspace.description ?? "",
  };
}

export function listWorkspaces(store: WorkspaceReader = getStore()): WorkspaceSummary[] {
  return store.listWorkspaces().map(workspaceSummary);
}

export function getWorkspace(id: string, store: WorkspaceLookup = getStore()): WorkspaceDetails | null {
  const workspace = store.getWorkspace(id);
  if (!workspace) return null;
  return {
    ...workspaceSummary(workspace),
    createdAt: workspace.createdAt,
    maxIterations: workspace.maxIterations,
    maxRunMinutes: workspace.maxRunMinutes,
    internetAccess: workspace.internetAccess,
    ...publicModelSelection(currentModelSelection(workspace)),
  };
}
