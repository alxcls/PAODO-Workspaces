// Workspace creation use case shared by every trigger.
import type { IWorkspaceStore } from "@/lib/infra/interfaces";
import { getStore } from "@/lib/infra/services";
import { validateWorkspaceName } from "@/lib/workspace/name";
import { workspaceSummary, type WorkspaceSummary } from "./read";

export interface CreateWorkspaceInput {
  name: string;
}

export async function createWorkspace(
  input: CreateWorkspaceInput,
  store: Pick<IWorkspaceStore, "createWorkspace"> = getStore(),
): Promise<WorkspaceSummary> {
  const name = validateWorkspaceName(input.name);
  return workspaceSummary(await store.createWorkspace(name));
}
