// Production composition for ContainerManager. This is the only module that binds Docker lifecycle
// policy to the concrete workspace registry and credential store.
import { createHash } from "crypto";
import { defaultWorkspaceStore } from "@/lib/infra/workspace/registry";
import { listSecretMeta, PROXY_TOKEN_FORMAT_VERSION } from "../security/workspaceSecretStore";
import { buildCredentialEnv, installProxyCA } from "./containerCredentials";
import { ContainerManager, type ContainerWorkspaceDependencies } from "./containerManager";
import { DockerClient } from "./dockerClient";

function credentialFingerprint(workspaceId: string, internetAccess: boolean): string {
  const names = listSecretMeta(workspaceId)
    .map((secret) => secret.name)
    .sort();
  return createHash("sha256")
    .update(`${PROXY_TOKEN_FORMAT_VERSION}\0${internetAccess}\0${names.join(",")}`)
    .digest("hex");
}

const workspaceDeps: ContainerWorkspaceDependencies = {
  internetAccessFor(workspaceId) {
    const workspace = defaultWorkspaceStore.getWorkspace(workspaceId);
    return workspace ? (workspace.internetAccess ?? true) : false;
  },
  credentialFingerprint,
  credentialEnvironment: buildCredentialEnv,
  installProxyCA,
};

// Module-level state is intentional: Next.js hot reload does not re-import this server-only
// composition through the app bundle.
export const defaultContainerManager = new ContainerManager(new DockerClient(), workspaceDeps);
