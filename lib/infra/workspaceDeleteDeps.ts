// Infrastructure composition for the workspace-deletion use case. Resource ownership belongs here:
// adding a new persisted or runtime resource extends this plan without changing deletion policy.
import { rm } from "fs/promises";
import path from "path";
import { deleteWorkspaceConversations } from "@/lib/conversations/store";
import { disconnectWorkspace } from "@/lib/drives/store";
import { removeWorkspaceFromGraph } from "@/lib/agent/graph";
import type { WorkspaceDeleteDeps, WorkspaceDeleteStage } from "@/lib/operations/workspace/delete";
import { createAuditLogger, createLogger } from "./logger";
import { WORKSPACES_ROOT, workspaceHomeDir } from "./paths";
import { getCredentialProxy } from "./proxy";
import { deleteInternetAccessPolicy } from "./proxy/internetAccessPolicy";
import { removeWorkspace as removeWorkspaceCredentials } from "./security/credentialStore";
import { deleteAllForWorkspace } from "./security/workspaceSecretStore";
import { clearSchedule } from "./schedules/scheduleStore";
import { getContainers, getStore, getVersioning } from "./services";

const log = createLogger("workspaceOperations");
const audit = createAuditLogger("workspaceOperations");

const stage = (name: string, run: WorkspaceDeleteStage["run"]): WorkspaceDeleteStage => ({ name, run });

/** Builds the production adapters lazily, after infrastructure startup has completed. */
export function workspaceDeleteDeps(): WorkspaceDeleteDeps {
  const containers = getContainers();
  const versioning = getVersioning();

  return {
    registry: getStore(),
    log,
    audit,
    deriveWorkspaceDir: (id) => path.join(WORKSPACES_ROOT, id),
    cleanupGroups: [
      [stage("drive_connections", ({ id }) => disconnectWorkspace(id))],
      [stage("agent_graph", ({ id }) => removeWorkspaceFromGraph(id))],
      [stage("credentials", ({ id }) => removeWorkspaceCredentials(id))],
      [
        stage("conversations", ({ id }) => deleteWorkspaceConversations(id)),
        stage("third_party_secrets", ({ id }) => deleteAllForWorkspace(id)),
        stage("credential_proxy_rules", ({ id }) => getCredentialProxy().clearRules(id)),
        stage("internet_access_policy", ({ id }) => deleteInternetAccessPolicy(id)),
        stage("schedule", ({ id }) => clearSchedule(id)),
      ],
      // Stop and remove the container before touching its mounted directory. Keeping these in one
      // parallel group lets a failed/running container race the directory removal and retain open
      // files after the API reports success.
      [stage("container", ({ id }) => containers.remove(id))],
      [
        stage("workspace_directory", ({ dir }) => containers.deleteWorkspaceDir(dir)),
        stage("version_history", ({ id }) => versioning.deleteRepo(id)),
        stage("agent_permissions", ({ id }) =>
          rm(path.join(WORKSPACES_ROOT, ".agent-permissions", `${id}.json`), { force: true }),
        ),
        // Hundreds of MB of installed runtimes per workspace — grouped with the container removal
        // above so nothing is still holding these files open. Owned by uid 1000 like the app, so a
        // plain rm reaches them; only the workspace tree needs the root-container treatment.
        stage("agent_home", ({ id }) => rm(workspaceHomeDir(id), { recursive: true, force: true })),
      ],
    ],
  };
}
