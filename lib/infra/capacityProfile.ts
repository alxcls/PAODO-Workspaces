export const DEFAULT_APP_MEMORY_LIMIT = "2g";
export const DEFAULT_APP_CPUS = "2.0";
export const DEFAULT_WORKSPACE_MEMORY_LIMIT = "1g";
export const DEFAULT_WORKSPACE_CPUS = "1.0";
export const DEFAULT_WORKSPACE_PIDS_LIMIT = "512";
export const APP_PIDS_LIMIT = 1024;

export interface CapacityProfile {
  appMemoryLimit: string;
  appCpus: string;
  appPidsLimit: number;
  workspaceMemoryLimit: string;
  workspaceCpus: string;
  workspacePidsLimit: string;
}

const configured = (value: string | undefined, fallback: string): string => value?.trim() || fallback;

type CapacityEnvironment = Record<string, string | undefined>;

/**
 * The small, host-dependent resource profile used for experiments and production guardrails.
 * Agent concurrency is owned by executionCapacity; this profile describes Docker resource walls.
 */
export function readCapacityProfile(env: CapacityEnvironment = process.env): CapacityProfile {
  return {
    appMemoryLimit: configured(env.APP_MEMORY_LIMIT, DEFAULT_APP_MEMORY_LIMIT),
    appCpus: configured(env.APP_CPUS, DEFAULT_APP_CPUS),
    appPidsLimit: APP_PIDS_LIMIT,
    workspaceMemoryLimit: configured(env.CONTAINER_MEMORY, DEFAULT_WORKSPACE_MEMORY_LIMIT),
    workspaceCpus: configured(env.CONTAINER_CPUS, DEFAULT_WORKSPACE_CPUS),
    workspacePidsLimit: configured(env.CONTAINER_PIDS_LIMIT, DEFAULT_WORKSPACE_PIDS_LIMIT),
  };
}

export const capacityProfile = readCapacityProfile();
