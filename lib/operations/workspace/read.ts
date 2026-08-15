// Public workspace projections and trigger-neutral queries.
import type { IWorkspaceStore } from "@/lib/infra/interfaces";
import { getStore } from "@/lib/infra/services";
import { defaultModelSelection, getProviderMetadata } from "@/lib/agent/buildModel";
import { providerHasKey } from "@/lib/operations/settings/providerKeys";
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
  /** Whether the selected provider currently has an API key configured. */
  llmProviderHasKey: boolean;
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
 * allows.
 *
 * A stored choice is returned as-is, unexamined: this projects what the workspace holds, it does not
 * police it. Nothing reachable here can be pointed at a withdrawn provider anyway — startup clears
 * those selections (clearWithdrawnLlmSelections), which puts the workspace back on this function's
 * defaults, and validateMetadata refuses to write a new one.
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

export function getWorkspace(
  id: string,
  store: WorkspaceLookup = getStore(),
  hasProviderKey: (provider: string) => boolean = providerHasKey,
): WorkspaceDetails | null {
  const workspace = store.getWorkspace(id);
  if (!workspace) return null;
  const modelSelection = currentModelSelection(workspace);
  return {
    ...workspaceSummary(workspace),
    createdAt: workspace.createdAt,
    maxIterations: workspace.maxIterations,
    maxRunMinutes: workspace.maxRunMinutes,
    internetAccess: workspace.internetAccess,
    ...publicModelSelection(modelSelection),
    llmProviderHasKey: hasProviderKey(modelSelection.provider),
  };
}
