// Permanent removal of a workspace and every resource keyed by its id. Kept apart from the read and
// update operations because deletion is the only path that reaches the container runtime, git
// versioning, the Drive store, the agent graph and the filesystem at once — and the only one whose
// every step is audit-logged.
import { getContainers, getStore, getVersioning } from "@/lib/infra/services";
import { removeWorkspace as removeWorkspaceCredentials } from "@/lib/infra/security/credentialStore";
import { createAuditLogger, createLogger } from "@/lib/infra/logger";
import { disconnectWorkspace } from "@/lib/workspace/driveStore";
import { removeWorkspaceFromGraph } from "@/lib/workspace/workspaceGraph";
import { deleteWorkspaceConversations } from "@/lib/workspace/conversationStore";
import { deleteAllForWorkspace } from "@/lib/infra/security/workspaceSecretStore";
import { getCredentialProxy } from "@/lib/infra/proxy";
import { deleteInternetAccessPolicy } from "@/lib/infra/proxy/internetAccessPolicy";
import { clearSchedule } from "@/lib/infra/schedules/scheduleStore";
import { rm } from "fs/promises";
import { existsSync } from "fs";
import path from "path";
import { WORKSPACES_ROOT } from "@/lib/infra/paths";

export interface DeleteWorkspaceResult {
  deleted: boolean;
  resumed?: true;
}

const deleteLog = createLogger("workspaceOperations");
const deleteAudit = createAuditLogger("workspaceOperations");

async function runDeleteCleanup(
  workspaceId: string,
  stage: string,
  cleanup: () => unknown | Promise<unknown>,
): Promise<void> {
  try {
    await cleanup();
    deleteLog.debug(
      { event: "workspace_delete_stage_completed", outcome: "diagnostic_recorded", workspaceId, stage },
      "workspace deletion stage completed",
    );
  } catch (err) {
    deleteLog.error(
      {
        event: "workspace_delete_cleanup_failed",
        outcome: "workspace_cleanup_incomplete",
        code: "INTERNAL_ERROR",
        err,
        workspaceId,
        stage,
      },
      "workspace deletion cleanup failed",
    );
    throw err;
  }
}

/**
 * Permanently removes a workspace and every id-keyed resource it owns. Cleanup is resumable: a
 * missing registry record is treated as a possibly interrupted prior deletion, so all safe stages
 * run again and the registry is finalized last.
 */
export async function deleteWorkspace(id: string): Promise<DeleteWorkspaceResult> {
  const store = getStore();
  const workspace = store.getWorkspace(id);
  const resuming = !workspace;
  const dir = workspace?.dir ?? path.join(WORKSPACES_ROOT, id);
  const deleteDirectory = !resuming || existsSync(dir);

  deleteAudit.info(
    {
      event: "workspace_delete_started",
      outcome: "workspace_deletion_started",
      workspaceId: id,
      workspaceName: workspace?.name,
      resuming,
    },
    resuming ? "resuming an incomplete workspace deletion" : "workspace deletion started",
  );

  await runDeleteCleanup(id, "drive_connections", () => disconnectWorkspace(id));
  await runDeleteCleanup(id, "agent_graph", () => removeWorkspaceFromGraph(id));
  await runDeleteCleanup(id, "credentials", () => removeWorkspaceCredentials(id));
  await Promise.all([
    runDeleteCleanup(id, "conversations", () => deleteWorkspaceConversations(id)),
    runDeleteCleanup(id, "third_party_secrets", () => deleteAllForWorkspace(id)),
    runDeleteCleanup(id, "credential_proxy_rules", () => getCredentialProxy().clearRules(id)),
    runDeleteCleanup(id, "internet_access_policy", () => deleteInternetAccessPolicy(id)),
    runDeleteCleanup(id, "schedule", () => clearSchedule(id)),
  ]);
  await Promise.all([
    runDeleteCleanup(id, "container", () => getContainers().remove(id)),
    ...(deleteDirectory
      ? [runDeleteCleanup(id, "workspace_directory", () => getContainers().deleteWorkspaceDir(dir))]
      : []),
    runDeleteCleanup(id, "version_history", () => getVersioning().deleteRepo(id)),
    runDeleteCleanup(id, "agent_permissions", () =>
      rm(path.join(WORKSPACES_ROOT, ".agent-permissions", `${id}.json`), { force: true }),
    ),
  ]);
  await runDeleteCleanup(id, "workspace_registry", () => store.deleteWorkspace(id));

  deleteAudit.info(
    {
      event: "workspace_deleted",
      outcome: "workspace_and_owned_resources_deleted",
      workspaceId: id,
      workspaceName: workspace?.name,
      resumed: resuming,
    },
    resuming ? "incomplete workspace deletion completed" : "workspace deleted",
  );
  return { deleted: !resuming, ...(resuming ? { resumed: true as const } : {}) };
}
