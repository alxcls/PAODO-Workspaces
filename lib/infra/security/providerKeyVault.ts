// App-only encrypted vault for deployment-wide provider API keys. The credential proxy image does
// not contain this module and mounts neither this file nor its independent master key.
import { readFileSync } from "fs";
import path from "path";
import { atomicSaveJson } from "../jsonPersist";
import { createLogger } from "../logger";
import { decryptProviderEnvelope, encryptProviderEnvelope, isEncEnvelope } from "./providerKeyEncryption";
import { PROVIDER_VAULT_ROOT } from "./providerKeyPaths";

const log = createLogger("providerKeyVault");

export const PROVIDER_VAULT_FILE = path.join(PROVIDER_VAULT_ROOT, "vault.json");

export interface VaultProviderKeyEntry {
  value: string;
  createdAt: string;
}

export type VaultProviderKeys = Record<string, VaultProviderKeyEntry>;

interface ProviderVaultData {
  version: 1;
  providerKeys: VaultProviderKeys;
}

interface ProviderVaultState {
  data: ProviderVaultData;
  initialLoadError: unknown;
}

function emptyVault(): ProviderVaultData {
  return { version: 1, providerKeys: {} };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertVaultData(value: unknown): asserts value is ProviderVaultData {
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.providerKeys)) {
    throw new Error("provider vault has an unsupported schema");
  }
  for (const [provider, raw] of Object.entries(value.providerKeys)) {
    if (
      !isRecord(raw) ||
      typeof raw.value !== "string" ||
      typeof raw.createdAt !== "string" ||
      !Number.isFinite(Date.parse(raw.createdAt))
    ) {
      throw new Error(`provider key record ${provider} is malformed`);
    }
  }
}

function readVaultFile(): ProviderVaultData {
  const parsed: unknown = JSON.parse(readFileSync(PROVIDER_VAULT_FILE, "utf8"));
  if (!isEncEnvelope(parsed)) throw new Error("provider vault is not an encrypted envelope");
  const decrypted: unknown = JSON.parse(decryptProviderEnvelope(parsed));
  assertVaultData(decrypted);
  return decrypted;
}

function loadInitialState(): ProviderVaultState {
  try {
    return { data: readVaultFile(), initialLoadError: null };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { data: emptyVault(), initialLoadError: null };
    }
    log.error(
      { event: "provider_vault_load_failed", outcome: "empty_vault_used", err, filePath: PROVIDER_VAULT_FILE },
      "failed to load encrypted provider vault — starting empty",
    );
    return { data: emptyVault(), initialLoadError: err };
  }
}

const g = global as typeof global & { _providerKeyVaultState?: ProviderVaultState };
g._providerKeyVaultState ??= loadInitialState();
const state = g._providerKeyVaultState;

function replaceRecord(target: VaultProviderKeys, next: VaultProviderKeys): void {
  for (const key of Object.keys(target)) delete target[key];
  Object.assign(target, next);
}

export function assertProviderVaultAvailable(): void {
  if (state.initialLoadError) throw state.initialLoadError;
}

export function providerKeyRecords(): VaultProviderKeys {
  return state.data.providerKeys;
}

/** Persist first, then publish the new state so a failed write cannot create an in-memory-only key. */
export function commitProviderKeys(next: VaultProviderKeys, context: Record<string, unknown>): void {
  const data: ProviderVaultData = { version: 1, providerKeys: next };
  try {
    atomicSaveJson(PROVIDER_VAULT_FILE, encryptProviderEnvelope(JSON.stringify(data)));
  } catch (err) {
    log.error(
      {
        event: "provider_vault_save_failed",
        outcome: "provider_key_change_not_persisted",
        err,
        filePath: PROVIDER_VAULT_FILE,
        ...context,
      },
      "failed to save encrypted provider vault",
    );
    throw err;
  }
  replaceRecord(state.data.providerKeys, next);
}
