// The workspace's outbound network access. A registry field on the surface, but three systems have to
// agree for the toggle to mean anything: the registry records it, the credential proxy enforces it, and
// the running container has to be torn down so its network is rebuilt with the correct --internal flag
// (containerManager.ts). Its own file because that agreement is a security boundary with a rollback
// rule, not a setter.
import type { IWorkspaceStore } from "@/lib/infra/interfaces";
import { getContainers } from "@/lib/infra/services";
import { setInternetAccessPolicy } from "@/lib/infra/proxy/internetAccessPolicy";
import { createLogger } from "@/lib/infra/logger";
import { WorkspaceUpdateError, WorkspaceUpdateFailure } from "./workspaceErrors";

export type EgressWriter = Pick<IWorkspaceStore, "setWorkspaceInternetAccess">;

export interface EgressServices {
  setPolicy(id: string, enabled: boolean): void;
  stopContainer(id: string): Promise<void>;
}

export interface EgressResult {
  /** False when the registry refused the write, which past a known-good id means the workspace vanished. */
  applied: boolean;
}

const log = createLogger("workspaceOperations");

function defaultEgressServices(): EgressServices {
  return {
    setPolicy: setInternetAccessPolicy,
    stopContainer: (id) => getContainers().stop(id),
  };
}

export function validateInternetAccess(value: unknown): boolean {
  if (typeof value !== "boolean") throw new WorkspaceUpdateError("internetAccess must be a boolean");
  return value;
}

/**
 * Sets the workspace's egress and brings the proxy and the running container in line with it.
 *
 * `previous` is the value to restore if the proxy rejects the change: the registry and the proxy policy
 * are one security boundary and must never be left disagreeing, so a failure there rolls the registry
 * back and raises rather than reporting success on a half-applied boundary. Container teardown is
 * part of that same success contract: if it cannot be confirmed, restore the previous policy and
 * store value and report failure.
 */
export async function setInternetAccess(
  id: string,
  enabled: boolean,
  previous: boolean,
  store: EgressWriter,
  services: EgressServices = defaultEgressServices(),
): Promise<EgressResult> {
  if (!store.setWorkspaceInternetAccess(id, enabled)) return { applied: false };

  try {
    services.setPolicy(id, enabled);
  } catch (err) {
    store.setWorkspaceInternetAccess(id, previous);
    log.error(
      { event: "internet_access_toggle_failed", outcome: "rolled_back", err, workspaceId: id },
      "failed to persist internet-access policy — rolled back",
    );
    throw new WorkspaceUpdateFailure("failed to persist internet-access policy");
  }

  try {
    await services.stopContainer(id);
  } catch (err) {
    let rollbackError: unknown;
    try {
      // Restore the proxy first. If that write fails, keep the store at the new value rather than
      // knowingly making the two persisted authorities disagree.
      services.setPolicy(id, previous);
      if (!store.setWorkspaceInternetAccess(id, previous)) {
        throw new Error("workspace disappeared while rolling back internet access");
      }
    } catch (rollback) {
      rollbackError = rollback;
    }
    // One literal outcome per branch: `outcome` is how the surfaced-log UI groups these records, so
    // the possible values have to be greppable in the source rather than computed here.
    if (rollbackError) {
      log.error(
        {
          event: "internet_access_toggle_stop_failed",
          outcome: "rollback_failed",
          err,
          rollbackError,
          workspaceId: id,
        },
        "failed to stop the workspace container while changing internet access",
      );
    } else {
      log.error(
        { event: "internet_access_toggle_stop_failed", outcome: "rolled_back", err, workspaceId: id },
        "failed to stop the workspace container while changing internet access",
      );
    }
    throw new WorkspaceUpdateFailure("failed to apply internet-access setting");
  }

  return { applied: true };
}
