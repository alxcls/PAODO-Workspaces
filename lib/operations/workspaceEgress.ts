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
  /** Non-fatal problems: the setting is persisted and enforced, but something downstream lagged. */
  warnings: string[];
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
 * back and raises rather than reporting success on a half-applied boundary. A container that cannot be
 * stopped is reported as a warning instead — the setting is persisted and enforced by the proxy, only
 * the network-layer teardown is pending.
 */
export async function setInternetAccess(
  id: string,
  enabled: boolean,
  previous: boolean,
  store: EgressWriter,
  services: EgressServices = defaultEgressServices(),
): Promise<EgressResult> {
  if (!store.setWorkspaceInternetAccess(id, enabled)) return { applied: false, warnings: [] };

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

  const warnings: string[] = [];
  try {
    await services.stopContainer(id);
  } catch (err) {
    const warning = "setting saved but the running container could not be stopped immediately";
    warnings.push(warning);
    log.error(
      { event: "internet_access_toggle_stop_failed", outcome: "setting_saved_container_pending", err, workspaceId: id },
      warning,
    );
  }

  return { applied: true, warnings };
}
