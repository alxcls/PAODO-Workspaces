// Roll a workspace's work-tree back to one of its snapshots.
//
// Separated from update.ts for the same reason delete.ts is: this is not a field write. It replaces
// the files on disk with an older revision and keeps no copy of what was there, so it is the second
// irreversible workspace operation and belongs beside the first rather than inside the receipt-
// producing metadata path.
//
// The reset writes host files that bind-mount live into the container, so there is nothing to
// restart afterwards — the running agent sees the restored tree on its next read.
import type { IWorkspaceVersionRestorer } from "@/lib/infra/interfaces";
import { getVersioning } from "@/lib/infra/services";
import { isSnapshotSha } from "@/lib/infra/git/sha";
import { WorkspaceUpdateError } from "./errors";

export interface RestoreWorkspaceInput {
  sha?: unknown;
}

export interface RestoreWorkspaceResult {
  restored: true;
  /** The snapshot the work-tree now sits at, echoed so a caller can confirm what it landed on. */
  sha: string;
}

/** Only the id and the work-tree path; the versioning service keys the git dir off the id. */
export interface RestoreTarget {
  id: string;
  dir: string;
}

/**
 * Restores an existing workspace to `sha`. A ref that is not a snapshot of THIS workspace is a
 * caller error, not a missing resource: the workspace was found, and the id it supplied for a
 * revision does not name one. Both rejections stay on the invalid-input path so a caller does not
 * have to distinguish "malformed" from "no longer in history" to know it must send a different ref.
 */
export async function restoreWorkspace(
  workspace: RestoreTarget,
  input: RestoreWorkspaceInput,
  versioning: IWorkspaceVersionRestorer = getVersioning(),
): Promise<RestoreWorkspaceResult> {
  if (!isSnapshotSha(input.sha)) {
    throw new WorkspaceUpdateError("invalid sha", { field: "sha" });
  }
  const sha = input.sha;

  if (!(await versioning.restore(workspace.id, workspace.dir, sha))) {
    throw new WorkspaceUpdateError("unknown sha", { field: "sha" });
  }
  return { restored: true, sha };
}
