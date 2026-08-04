// The skills a workspace declares in .skills/. Read-only by design: enabling the MCP endpoint exposes
// every declared skill as a tool, so the workspace agent decides that surface by authoring contracts
// and there is nothing here for a caller to write.
import { getStore } from "@/lib/infra/services";
import { loadSkills } from "@/lib/workspace/skillStore";
import type { WorkspaceReader } from "./workspaces";

/** One skill the workspace declares in .skills/ — an MCP tool while the MCP endpoint is enabled. */
export interface ExposedSkill {
  id: string;
  description: string;
}

/**
 * The declared skills, in the shape the MCP settings UI already shows. Separate from getWorkspace
 * because reading them touches the filesystem; callers that only need metadata should not pay for it.
 */
export async function listWorkspaceSkills(
  id: string,
  store: WorkspaceReader = getStore(),
  loader: (workspaceDir: string) => Promise<ExposedSkill[]> = loadSkills,
): Promise<ExposedSkill[]> {
  const workspace = store.getWorkspace(id);
  if (!workspace) return [];
  return (await loader(workspace.dir)).map((s) => ({ id: s.id, description: s.description }));
}
