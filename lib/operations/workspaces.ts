// Trigger-neutral workspace queries. UI routes, CLI-facing routes, MCP adapters, schedules, and
// other entry points should call operations like these instead of reimplementing workspace rules or
// response shapes. Authentication and transport formatting stay at the adapter boundary.
import type { IWorkspaceStore } from "@/lib/infra/interfaces";
import { getStore } from "@/lib/infra/services";
import { DEFAULT_LLM, type ReasoningEffort } from "@/lib/agent/interfaces";
import type { Workspace } from "@/lib/workspace/workspaceStore";
import { state, type CredentialState } from "@/lib/infra/security/credentialStore";

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

export interface WorkspaceAccessDetails {
  workspaceApiAccess: boolean;
  apiEndpoint: string | null;
  workspaceMcpAccess: boolean;
  mcpConnectionUrl: string | null;
}

type WorkspaceReader = Pick<IWorkspaceStore, "getWorkspace" | "listWorkspaces">;
type CredentialStateReader = (
  kind: "workspace-api" | "workspace-mcp",
  workspaceId: string,
) => Pick<CredentialState, "enabled" | "hasSecret">;

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

/**
 * Returns the external-access fields shown by the workspace UI without exposing either credential.
 * A URL is visible only while its channel is enabled and has a credential, matching CredentialPanel.
 */
export function getWorkspaceAccess(
  id: string,
  connectionOrigin: string,
  readCredentialState: CredentialStateReader = state,
): WorkspaceAccessDetails {
  const api = readCredentialState("workspace-api", id);
  const mcp = readCredentialState("workspace-mcp", id);
  const origin = connectionOrigin.replace(/\/+$/, "");

  return {
    workspaceApiAccess: api.enabled,
    apiEndpoint: api.enabled && api.hasSecret ? `${origin}/api/workspaces/${encodeURIComponent(id)}/agent` : null,
    workspaceMcpAccess: mcp.enabled,
    mcpConnectionUrl: mcp.enabled && mcp.hasSecret ? `${origin}/api/workspaces/${encodeURIComponent(id)}/mcp` : null,
  };
}
