// Infrastructure composition for the workspace-deletion use case. Resource ownership belongs here:
// adding a new persisted or runtime resource extends this plan without changing deletion policy.
import { rm } from "fs/promises";
import path from "path";
import { deleteWorkspaceConversations } from "@/lib/workspace/conversationStore";
import { disconnectWorkspace } from "@/lib/workspace/driveStore";
import { removeWorkspaceFromGraph } from "@/lib/workspace/workspaceGraph";
import type { WorkspaceDeleteDeps, WorkspaceDeleteStage } from "@/lib/operations/workspaceDelete";
import { createAuditLogger, createLogger } from "./logger";
import { WORKSPACES_ROOT } from "./paths";
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
      [
        stage("container", ({ id }) => containers.remove(id)),
        stage("workspace_directory", ({ dir }) => containers.deleteWorkspaceDir(dir)),
        stage("version_history", ({ id }) => versioning.deleteRepo(id)),
        stage("agent_permissions", ({ id }) =>
          rm(path.join(WORKSPACES_ROOT, ".agent-permissions", `${id}.json`), { force: true }),
        ),
      ],
    ],
  };
}
