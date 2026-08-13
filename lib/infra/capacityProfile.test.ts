import { describe, expect, it } from "vitest";
import {
  APP_PIDS_LIMIT,
  DEFAULT_APP_CPUS,
  DEFAULT_APP_MEMORY_LIMIT,
  DEFAULT_WORKSPACE_CPUS,
  DEFAULT_WORKSPACE_MEMORY_LIMIT,
  DEFAULT_WORKSPACE_PIDS_LIMIT,
  readCapacityProfile,
} from "./capacityProfile";

describe("capacity profile", () => {
  it("has one conservative default profile", () => {
    expect(readCapacityProfile({})).toEqual({
      appMemoryLimit: DEFAULT_APP_MEMORY_LIMIT,
      appCpus: DEFAULT_APP_CPUS,
      appPidsLimit: APP_PIDS_LIMIT,
      workspaceMemoryLimit: DEFAULT_WORKSPACE_MEMORY_LIMIT,
      workspaceCpus: DEFAULT_WORKSPACE_CPUS,
      workspacePidsLimit: DEFAULT_WORKSPACE_PIDS_LIMIT,
    });
  });

  it("reads only the essential operator knobs and ignores blank overrides", () => {
    expect(
      readCapacityProfile({
        APP_MEMORY_LIMIT: "3g",
        APP_CPUS: "1.5",
        CONTAINER_MEMORY: "768m",
        CONTAINER_CPUS: "0.75",
        CONTAINER_PIDS_LIMIT: "256",
      }),
    ).toEqual({
      appMemoryLimit: "3g",
      appCpus: "1.5",
      appPidsLimit: APP_PIDS_LIMIT,
      workspaceMemoryLimit: "768m",
      workspaceCpus: "0.75",
      workspacePidsLimit: "256",
    });

    expect(readCapacityProfile({ APP_MEMORY_LIMIT: "  " }).appMemoryLimit).toBe(DEFAULT_APP_MEMORY_LIMIT);
  });
});
