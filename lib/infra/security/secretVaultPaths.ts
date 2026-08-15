// Storage boundaries for every secret PAODO must be able to recover.
//
// Provider credentials and workspace-injected secrets have different trust boundaries: the app
// needs both, while the workspace-facing credential proxy must never be able to decrypt provider
// credentials. Each class therefore has its own encrypted vault AND its own master key, all outside
// ordinary workspace data.
import path from "path";
import { PROVIDER_VAULT_KEY_FILE, PROVIDER_VAULT_ROOT } from "./providerKeyPaths";
import { WORKSPACE_SECRET_VAULT_KEY_FILE, WORKSPACE_SECRET_VAULT_ROOT } from "./workspaceSecretPaths";

export { PROVIDER_VAULT_KEY_FILE, PROVIDER_VAULT_ROOT } from "./providerKeyPaths";
export { WORKSPACE_SECRET_VAULT_KEY_FILE, WORKSPACE_SECRET_VAULT_ROOT } from "./workspaceSecretPaths";

function contains(parent: string, child: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function overlaps(a: string, b: string): boolean {
  return contains(a, b) || contains(b, a);
}

/** Refuse configurations that collapse any two backup/security boundaries into one directory tree. */
export function assertSecretStorageSeparated(workspacesRoot: string): void {
  const boundaries = [
    { name: "workspace data", root: workspacesRoot },
    { name: "provider vault", root: PROVIDER_VAULT_ROOT },
    { name: "provider key", root: path.dirname(PROVIDER_VAULT_KEY_FILE) },
    { name: "workspace-secret vault", root: WORKSPACE_SECRET_VAULT_ROOT },
    { name: "workspace-secret key", root: path.dirname(WORKSPACE_SECRET_VAULT_KEY_FILE) },
  ];

  for (let i = 0; i < boundaries.length; i++) {
    for (let j = i + 1; j < boundaries.length; j++) {
      const left = boundaries[i];
      const right = boundaries[j];
      if (overlaps(left.root, right.root)) {
        throw new Error(`${left.name} and ${right.name} must use separate directory trees`);
      }
    }
  }
}
