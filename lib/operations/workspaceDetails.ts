// The complete trigger-neutral workspace read used by the UI and CLI. Capability modules retain
// ownership of their projections; this operation owns assembling them into one public result.
import { getWorkspaceAccess, type WorkspaceAccessDetails } from "./workspaceAccess";
import { listWorkspaceSecrets, type ThirdPartySecret } from "./workspaceSecrets";
import { listWorkspaceSkills, type ExposedSkill } from "./workspaceSkills";
import { getWorkspace, type WorkspaceDetails } from "./workspaces";

export type WorkspaceOverview = WorkspaceDetails &
  WorkspaceAccessDetails & {
    exposedSkills: ExposedSkill[];
    thirdPartySecrets: ThirdPartySecret[];
  };

export async function getWorkspaceOverview(id: string, connectionOrigin: string): Promise<WorkspaceOverview | null> {
  const workspace = getWorkspace(id);
  if (!workspace) return null;
  return {
    ...workspace,
    ...getWorkspaceAccess(id, connectionOrigin),
    exposedSkills: await listWorkspaceSkills(id),
    thirdPartySecrets: listWorkspaceSecrets(id),
  };
}
