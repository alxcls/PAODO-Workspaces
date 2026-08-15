// Deployment-wide LLM provider API keys, entered in the app rather than .env.
//
// These must stay recoverable — buildModel hands the plaintext to the provider SDK on every run —
// so this is encryption, not hashing (contrast credentialStore.ts, which only ever stores a SHA-256
// of the bearer tokens PAODO itself mints and can therefore never give one back). The at-rest
// envelope uses the same reviewed AES-256-GCM mechanics as workspace secrets, but an independent
// vault and independent master key. Both live on app-only mounts outside ordinary workspace data,
// so the credential proxy and workspace backups cannot recover provider credentials.
//
// ONE KEY PER PROVIDER, FOR THE WHOLE DEPLOYMENT. There is no workspace dimension here on purpose:
// the operator who runs the instance is the account holder, and a per-workspace key would mean a
// workspace could not switch provider without someone pasting a second key first.
//
// WHY THIS IS NOT THE WORKSPACE SECRET STORE. Workspace-secret values are swapped into a container's
// outbound HTTPS by the credential-proxy sidecar. Provider values go the other way: the app itself
// spends them, and neither proxy nor sandbox should see them. Separate vault/key pairs enforce that
// trust boundary at the container mounts instead of relying on two namespaces in one decryptable file.
import { createAuditLogger } from "../logger";
import {
  PROVIDER_VAULT_FILE,
  assertProviderVaultAvailable,
  commitProviderKeys,
  providerKeyRecords,
  type VaultProviderKeyEntry,
  type VaultProviderKeys,
} from "./providerKeyVault";

const audit = createAuditLogger("providerKeyStore");

export const PROVIDER_KEY_STORE_FILE = PROVIDER_VAULT_FILE;
type Store = VaultProviderKeys;

/** Everything about a stored key EXCEPT the key. The only shape that leaves this module by API. */
export interface ProviderKeyMeta {
  provider: string;
  createdAt: string;
  /** The last few characters, so an operator can tell which key is loaded without revealing it. */
  hint: string;
}

const store: Store = providerKeyRecords();

/**
 * Production startup calls this before accepting requests, so an empty fallback can never overwrite
 * a store that existed but could not be read or decrypted. Mirrors assertSecretStoreAvailable().
 */
export function assertProviderKeyStoreAvailable(): void {
  assertProviderVaultAvailable();
}

function save(next: Store, context: { operation: string; provider?: string }): void {
  commitProviderKeys(next, context);
}

// Short enough to be useless to an attacker, long enough to tell two of the operator's own keys
// apart. Keys shorter than this are shown whole — they cannot be real, and hiding a typo helps
// nobody diagnose it.
const HINT_LENGTH = 4;

function hintFor(value: string): string {
  return value.length <= HINT_LENGTH ? value : value.slice(-HINT_LENGTH);
}

/**
 * The plaintext key for a provider, or undefined when none is set.
 *
 * The ONLY way a value leaves this module. `undefined` is the normal state for a deployment whose
 * operator has not entered that provider's key yet — callers must treat it as "cannot run", not as
 * an error condition, and must never log the return value.
 */
export function getProviderKey(provider: string): string | undefined {
  return store[provider]?.value;
}

/** Whether a provider has a key set. The coarse status safe to publish in the model catalog. */
export function hasProviderKey(provider: string): boolean {
  return store[provider] !== undefined;
}

/** Store (or replace) a provider's key. Replacing in place — there is no rotation ceremony. */
export function setProviderKey(provider: string, value: string): void {
  const next = structuredClone(store);
  next[provider] = { value, createdAt: new Date().toISOString() } satisfies VaultProviderKeyEntry;
  save(next, { operation: "set_provider_key", provider });
  audit.info({ event: "provider_key_set", provider }, "provider API key set");
}

/** Remove a provider's key. Returns false when there was nothing stored. */
export function deleteProviderKey(provider: string): boolean {
  if (!store[provider]) return false;
  const next = structuredClone(store);
  delete next[provider];
  save(next, { operation: "delete_provider_key", provider });
  audit.info({ event: "provider_key_deleted", provider }, "provider API key deleted");
  return true;
}

/** Every stored key's metadata. Never carries a value — see ProviderKeyMeta. */
export function listProviderKeyMeta(): ProviderKeyMeta[] {
  return Object.entries(store).map(([provider, entry]) => ({
    provider,
    createdAt: entry.createdAt,
    hint: hintFor(entry.value),
  }));
}

/**
 * Delete every stored key whose provider is not in `allowed`, and report what went.
 *
 * This is what makes `<PROVIDER>_AVAILABLE=false` mean "nobody can spend on this" rather than merely
 * "hidden from the picker". Withdrawing a provider destroys its key, so a workspace still pointed at
 * it cannot keep billing the account after the operator believes they switched it off.
 *
 * DESTRUCTIVE AND NOT REVERSIBLE. Switching the flag back does not restore the key — it has to be
 * entered again. That is the trade the enforcement is worth, and the audit line is what makes it
 * explicable afterwards.
 *
 * Takes the allowed list rather than reading the environment itself: which providers exist and which
 * env var governs each is the provider registry's knowledge (lib/agent/buildModel.ts), and that
 * module pulls the LLM SDKs. An infra store must not drag those in, so the caller resolves the list.
 * It also means a provider deleted from the registry outright has its key purged on the next boot.
 */
export function purgeProviderKeysExcept(allowed: readonly string[]): string[] {
  const keep = new Set(allowed);
  const purged = Object.keys(store).filter((provider) => !keep.has(provider));
  if (purged.length === 0) return [];
  const next = structuredClone(store);
  for (const provider of purged) delete next[provider];
  save(next, { operation: "purge_withdrawn_provider_keys" });
  for (const provider of purged) {
    audit.warn(
      { event: "provider_key_purged", outcome: "stored_key_destroyed", provider },
      "provider withdrawn by configuration — its stored API key was deleted",
    );
  }
  return purged;
}

/** Test-only: drop everything in memory so one case's keys cannot decide another's outcome. */
export function _resetProviderKeysForTest(): void {
  for (const provider of Object.keys(store)) delete store[provider];
}
