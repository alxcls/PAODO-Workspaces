// Deployment-wide LLM provider API keys, entered in the app rather than .env.
//
// These must stay recoverable — buildModel hands the plaintext to the provider SDK on every run —
// so this is encryption, not hashing (contrast credentialStore.ts, which only ever stores a SHA-256
// of the bearer tokens PAODO itself mints and can therefore never give one back). The at-rest
// envelope is the same AES-256-GCM one the workspace secret store uses, keyed by the same host-only
// file, so a copied data/ directory exposes neither.
//
// ONE KEY PER PROVIDER, FOR THE WHOLE DEPLOYMENT. There is no workspace dimension here on purpose:
// the operator who runs the instance is the account holder, and a per-workspace key would mean a
// workspace could not switch provider without someone pasting a second key first.
//
// WHY THIS IS NOT THE WORKSPACE SECRET STORE. That store's values are never seen by this process at
// all — they are swapped into a container's outbound HTTPS by the credential-proxy sidecar, and the
// app only ever holds an opaque token for them. These values go the other way: the app itself spends
// them, and the sandbox must never see them. Same encryption, opposite direction, so they stay in
// separate files rather than sharing one with a scope field to tell them apart.
//
// The filename is dotted for the reason every app-owned file in this root is: a workspace directory
// is a plain join of WORKSPACES_ROOT and a workspace id, so an undotted name shares a namespace with
// them — and a sandbox container mounts only its own workspace directory, never the root, which is
// what keeps this file out of the sandbox's reach.
import { readFileSync } from "fs";
import path from "path";
import { WORKSPACES_ROOT } from "../paths";
import { atomicSaveJson } from "../jsonPersist";
import { createAuditLogger, createLogger } from "../logger";
import { isEncEnvelope, encryptToEnvelope, decryptFromEnvelope } from "./secretsEncryption";

const log = createLogger("providerKeyStore");
const audit = createAuditLogger("providerKeyStore");

const FILE = path.join(WORKSPACES_ROOT, ".provider-keys.json");
export const PROVIDER_KEY_STORE_FILE = FILE;

interface KeyEntry {
  value: string;
  createdAt: string;
}

/** provider id → the key that authenticates this deployment to it. */
type Store = Record<string, KeyEntry>;

/** Everything about a stored key EXCEPT the key. The only shape that leaves this module by API. */
export interface ProviderKeyMeta {
  provider: string;
  createdAt: string;
  /** The last few characters, so an operator can tell which key is loaded without revealing it. */
  hint: string;
}

// Held on the Node global: the custom server (which purges at startup) and the webpack-bundled API
// routes (which read and write) load this module into separate scopes — see globalSingleton for the
// same problem stated at length. A plain module-level binding would give each its own store.
const g = global as typeof global & { _providerKeys?: Store };
let initialLoadError: unknown = null;

if (!g._providerKeys) {
  g._providerKeys = {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(FILE, "utf-8"));
    // Unlike the workspace secret store there is no legacy plaintext era to migrate from: this file
    // has only ever existed encrypted, so anything that is not an envelope is a corrupt file rather
    // than an older format, and is treated as such.
    if (!isEncEnvelope(parsed)) throw new Error("provider key store is not an encrypted envelope");
    g._providerKeys = JSON.parse(decryptFromEnvelope(parsed)) as Store;
  } catch (err) {
    // ENOENT is the normal first-run case — a deployment starts with no keys by design. Anything
    // else (corrupt ciphertext, wrong key, unreadable file) starts empty here but is remembered, so
    // assertProviderKeyStoreAvailable can refuse to let the process serve requests. Without that
    // gate the first save would overwrite a file full of keys that were merely unreadable today.
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      initialLoadError = err;
      log.error(
        { event: "provider_key_store_load_failed", outcome: "empty_provider_key_store_used", err, filePath: FILE },
        "failed to load provider key store — starting empty",
      );
    }
  }
}
const store = g._providerKeys;

/**
 * Production startup calls this before accepting requests, so an empty fallback can never overwrite
 * a store that existed but could not be read or decrypted. Mirrors assertSecretStoreAvailable().
 */
export function assertProviderKeyStoreAvailable(): void {
  if (initialLoadError) throw initialLoadError;
}

function save(context: { operation: string; provider?: string }): void {
  try {
    atomicSaveJson(FILE, encryptToEnvelope(JSON.stringify(store)));
  } catch (err) {
    log.error(
      {
        event: "provider_key_store_save_failed",
        outcome: "provider_key_change_not_persisted",
        err,
        filePath: FILE,
        ...context,
      },
      "failed to save provider key store",
    );
    throw err;
  }
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
  store[provider] = { value, createdAt: new Date().toISOString() };
  save({ operation: "set_provider_key", provider });
  audit.info({ event: "provider_key_set", provider }, "provider API key set");
}

/** Remove a provider's key. Returns false when there was nothing stored. */
export function deleteProviderKey(provider: string): boolean {
  if (!store[provider]) return false;
  delete store[provider];
  save({ operation: "delete_provider_key", provider });
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
  for (const provider of purged) delete store[provider];
  save({ operation: "purge_withdrawn_provider_keys" });
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
