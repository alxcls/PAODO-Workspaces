// AES-256-GCM encryption for workspace-injected secrets.
// The plaintext must stay recoverable (the proxy injects real values), so this is not hashing —
// it protects the vault at rest. The master key is stored on a separate mount, so a workspace-data
// backup or encrypted-vault backup alone cannot expose the values. A full host compromise that can
// read both mounts remains out of scope.
//
// The key file is generated on demand with mode 0600 and cached on `global` so the custom server and
// Next.js route bundles (separate module instances) share one key. Docker mounts its directory apart
// from both the workspace-data and encrypted-vault volumes.
import { WORKSPACE_SECRET_VAULT_KEY_FILE } from "./workspaceSecretPaths";
import { decryptWithKey, encryptWithKey, getVaultKey, isEncEnvelope, type EncEnvelope } from "./vaultEncryption";

export { isEncEnvelope, type EncEnvelope };

export function getSecretsEncKey(): Buffer {
  return getVaultKey(WORKSPACE_SECRET_VAULT_KEY_FILE, "workspace-secrets", "workspaceSecretEncryption");
}

export function encryptToEnvelope(plaintext: string): EncEnvelope {
  return encryptWithKey(plaintext, getSecretsEncKey());
}

// Throws on any tamper (GCM auth failure), wrong key, or malformed envelope — callers fail closed.
export function decryptFromEnvelope(env: EncEnvelope): string {
  return decryptWithKey(env, getSecretsEncKey());
}
