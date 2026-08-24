// The complete trigger-neutral workspace read used by the UI and CLI. Capability modules retain
// ownership of their projections; this operation owns assembling them into one public result.
import { getWorkspaceAccess, type WorkspaceAccessDetails } from "./access";
import { listWorkspaceSecrets, type ThirdPartySecret } from "./secrets";
import { listWorkspaceSkills, type ExposedSkill } from "./skills";
import { getWorkspace, type WorkspaceDetails } from "./read";
import { workspaceConnectionCounts, type WorkspaceConnectionCounts } from "../connections/counts";

export type WorkspaceOverview = WorkspaceDetails &
  WorkspaceAccessDetails & {
    exposedSkills: ExposedSkill[];
    thirdPartySecrets: ThirdPartySecret[];
    /** How much this workspace is connected to, not what it is connected to: the listing at
     *  /api/drive-connections and /api/workspace-graph owns the detail and the ids. Present even when
     *  every count is zero, so a caller reads "none" rather than inferring it from a missing field. */
    connections: WorkspaceConnectionCounts;
  };

export async function getWorkspaceOverview(id: string, connectionOrigin: string): Promise<WorkspaceOverview | null> {
  const workspace = getWorkspace(id);
  if (!workspace) return null;
  return {
    ...workspace,
    ...getWorkspaceAccess(id, connectionOrigin),
    exposedSkills: await listWorkspaceSkills(id),
    thirdPartySecrets: listWorkspaceSecrets(id),
    connections: workspaceConnectionCounts(id),
  };
}
