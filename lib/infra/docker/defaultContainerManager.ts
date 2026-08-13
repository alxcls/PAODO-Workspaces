// Production composition for ContainerManager. This is the only module that binds Docker lifecycle
// policy to the concrete workspace registry and credential store.
import { defaultWorkspaceStore } from "@/lib/infra/workspace/registry";
import { buildExecEnv, buildRunEnv, installProxyCA } from "./containerCredentials";
import { ContainerManager, type ContainerWorkspaceDependencies } from "./containerManager";
import { DockerClient } from "./dockerClient";

const workspaceDeps: ContainerWorkspaceDependencies = {
  internetAccessFor(workspaceId) {
    const workspace = defaultWorkspaceStore.getWorkspace(workspaceId);
    return workspace ? (workspace.internetAccess ?? true) : false;
  },
  runEnvironment: buildRunEnv,
  execEnvironment: buildExecEnv,
  installProxyCA,
};

// Module-level state is intentional: Next.js hot reload does not re-import this server-only
// composition through the app bundle.
export const defaultContainerManager = new ContainerManager(new DockerClient(), workspaceDeps);
