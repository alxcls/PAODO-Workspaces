// Permanent removal of a workspace and every resource keyed by its id. Kept apart from the read and
// update operations because deletion is the only path that reaches all owned resources at once — and
// the only one whose every step is audit-logged. The concrete cleanup plan is assembled at the HTTP
// composition boundary; this module only owns deletion policy and ordering.

export interface DeleteWorkspaceResult {
  deleted: true;
}

export interface WorkspaceDeletionTarget {
  id: string;
  name: string;
  dir: string;
}

/** The registry is deliberately narrower than the application's full workspace store. */
export interface WorkspaceDeleteRegistry {
  getWorkspace(id: string): WorkspaceDeletionTarget | undefined;
  deleteWorkspace(id: string): boolean | Promise<boolean>;
}

/** One independently observable resource cleanup. */
export interface WorkspaceDeleteStage {
  name: string;
  run(workspace: WorkspaceDeletionTarget): unknown | Promise<unknown>;
}

interface DeleteLogger {
  debug(fields: Record<string, unknown>, message: string): void;
  error(fields: Record<string, unknown>, message: string): void;
}

interface DeleteAuditLogger {
  info(fields: Record<string, unknown>, message: string): void;
}

export interface WorkspaceDeleteDeps {
  registry: WorkspaceDeleteRegistry;
  /** Groups run in order; stages within a group may run concurrently. */
  cleanupGroups: readonly (readonly WorkspaceDeleteStage[])[];
  log: DeleteLogger;
  audit: DeleteAuditLogger;
}

async function runDeleteCleanup(
  workspaceId: string,
  stage: WorkspaceDeleteStage,
  workspace: WorkspaceDeletionTarget,
  log: DeleteLogger,
): Promise<void> {
  try {
    await stage.run(workspace);
    log.debug(
      { event: "workspace_delete_stage_completed", outcome: "diagnostic_recorded", workspaceId, stage: stage.name },
      "workspace deletion stage completed",
    );
  } catch (err) {
    log.error(
      {
        event: "workspace_delete_cleanup_failed",
        outcome: "workspace_cleanup_incomplete",
        code: "INTERNAL_ERROR",
        err,
        workspaceId,
        stage: stage.name,
      },
      "workspace deletion cleanup failed",
    );
    throw err;
  }
}

/**
 * Permanently removes an existing workspace and every resource it owns. The registry is finalized
 * last, so a cleanup failure leaves the workspace addressable and the caller can retry the same
 * deletion. A missing registry record is not evidence of an interrupted deletion and is reported
 * as not found without touching unrelated id-keyed stores.
 */
export async function deleteWorkspace(id: string, deps: WorkspaceDeleteDeps): Promise<DeleteWorkspaceResult | null> {
  const workspace = deps.registry.getWorkspace(id);
  if (!workspace) return null;

  deps.audit.info(
    {
      event: "workspace_delete_started",
      outcome: "workspace_deletion_started",
      workspaceId: id,
      workspaceName: workspace.name,
    },
    "workspace deletion started",
  );

  for (const group of deps.cleanupGroups) {
    await Promise.all(group.map((stage) => runDeleteCleanup(id, stage, workspace, deps.log)));
  }
  await runDeleteCleanup(
    id,
    { name: "workspace_registry", run: () => deps.registry.deleteWorkspace(id) },
    workspace,
    deps.log,
  );

  deps.audit.info(
    {
      event: "workspace_deleted",
      outcome: "workspace_and_owned_resources_deleted",
      workspaceId: id,
      workspaceName: workspace.name,
    },
    "workspace deleted",
  );
  return { deleted: true };
}
