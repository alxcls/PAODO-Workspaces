// Provider credentials use their own key file. This module is intentionally absent from the
// credential-proxy image, and that image mounts neither the provider vault nor this key.
import { PROVIDER_VAULT_KEY_FILE } from "./providerKeyPaths";
import { decryptWithKey, encryptWithKey, getVaultKey, isEncEnvelope, type EncEnvelope } from "./vaultEncryption";

export { isEncEnvelope, type EncEnvelope };

export function getProviderVaultKey(): Buffer {
  return getVaultKey(PROVIDER_VAULT_KEY_FILE, "provider-keys", "providerKeyEncryption");
}

export function encryptProviderEnvelope(plaintext: string): EncEnvelope {
  return encryptWithKey(plaintext, getProviderVaultKey());
}

export function decryptProviderEnvelope(envelope: EncEnvelope): string {
  return decryptWithKey(envelope, getProviderVaultKey());
}
