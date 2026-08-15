// Encrypted vault containing only secrets intended for credential-proxy injection. The proxy gets
// read-only access to this vault and its key; provider credentials live in a different vault/key
// pair that is not mounted into the proxy at all.
import { readFileSync } from "fs";
import path from "path";
import { atomicSaveJson } from "../jsonPersist";
import { createLogger } from "../logger";
import { decryptFromEnvelope, encryptToEnvelope, isEncEnvelope } from "./secretsEncryption";
import { WORKSPACE_SECRET_VAULT_ROOT } from "./workspaceSecretPaths";

const log = createLogger("workspaceSecretVault");

export const WORKSPACE_SECRET_VAULT_FILE = path.join(WORKSPACE_SECRET_VAULT_ROOT, "vault.json");

export interface VaultWorkspaceSecretEntry {
  value: string;
  createdAt: string;
  domains: string[];
}

export type VaultWorkspaceSecrets = Record<string, Record<string, VaultWorkspaceSecretEntry>>;

interface WorkspaceSecretVaultData {
  version: 1;
  workspaceSecrets: VaultWorkspaceSecrets;
}

interface WorkspaceSecretVaultState {
  data: WorkspaceSecretVaultData;
  initialLoadError: unknown;
}

function emptyVault(): WorkspaceSecretVaultData {
  return { version: 1, workspaceSecrets: {} };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertVaultData(value: unknown): asserts value is WorkspaceSecretVaultData {
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.workspaceSecrets)) {
    throw new Error("workspace-secret vault has an unsupported schema");
  }
  for (const [workspaceId, rawWorkspace] of Object.entries(value.workspaceSecrets)) {
    if (!isRecord(rawWorkspace)) throw new Error(`workspace secret namespace ${workspaceId} is malformed`);
    for (const [name, raw] of Object.entries(rawWorkspace)) {
      if (
        !isRecord(raw) ||
        typeof raw.value !== "string" ||
        typeof raw.createdAt !== "string" ||
        !Number.isFinite(Date.parse(raw.createdAt)) ||
        !Array.isArray(raw.domains) ||
        !raw.domains.every((domain) => typeof domain === "string")
      ) {
        throw new Error(`workspace secret record ${workspaceId}/${name} is malformed`);
      }
    }
  }
}

function readVaultFile(): WorkspaceSecretVaultData {
  const parsed: unknown = JSON.parse(readFileSync(WORKSPACE_SECRET_VAULT_FILE, "utf8"));
  if (!isEncEnvelope(parsed)) throw new Error("workspace-secret vault is not an encrypted envelope");
  const decrypted: unknown = JSON.parse(decryptFromEnvelope(parsed));
  assertVaultData(decrypted);
  return decrypted;
}

function loadInitialState(): WorkspaceSecretVaultState {
  try {
    return { data: readVaultFile(), initialLoadError: null };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { data: emptyVault(), initialLoadError: null };
    }
    log.error(
      {
        event: "workspace_secret_vault_load_failed",
        outcome: "empty_vault_used",
        err,
        filePath: WORKSPACE_SECRET_VAULT_FILE,
      },
      "failed to load encrypted workspace-secret vault — starting empty",
    );
    return { data: emptyVault(), initialLoadError: err };
  }
}

const g = global as typeof global & { _workspaceSecretVaultState?: WorkspaceSecretVaultState };
g._workspaceSecretVaultState ??= loadInitialState();
const state = g._workspaceSecretVaultState;

function replaceRecord(target: VaultWorkspaceSecrets, next: VaultWorkspaceSecrets): void {
  for (const key of Object.keys(target)) delete target[key];
  Object.assign(target, next);
}

export function assertWorkspaceSecretVaultAvailable(): void {
  if (state.initialLoadError) throw state.initialLoadError;
}

export function workspaceSecretRecords(): VaultWorkspaceSecrets {
  return state.data.workspaceSecrets;
}

/** Persist first, then publish the new state so failed writes never create memory-only secrets. */
export function commitWorkspaceSecrets(next: VaultWorkspaceSecrets, context: Record<string, unknown>): void {
  const data: WorkspaceSecretVaultData = { version: 1, workspaceSecrets: next };
  try {
    atomicSaveJson(WORKSPACE_SECRET_VAULT_FILE, encryptToEnvelope(JSON.stringify(data)));
  } catch (err) {
    log.error(
      {
        event: "workspace_secret_vault_save_failed",
        outcome: "secret_change_not_persisted",
        err,
        filePath: WORKSPACE_SECRET_VAULT_FILE,
        ...context,
      },
      "failed to save encrypted workspace-secret vault",
    );
    throw err;
  }
  replaceRecord(state.data.workspaceSecrets, next);
}

/** Sidecar-only reload. Missing or unreadable storage clears live injection rules (fail closed). */
export function reloadWorkspaceSecretVault(): void {
  let next = emptyVault();
  try {
    next = readVaultFile();
    state.initialLoadError = null;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      state.initialLoadError = null;
    } else {
      state.initialLoadError = err;
      log.error(
        {
          event: "workspace_secret_vault_reload_failed",
          outcome: "live_secrets_cleared",
          err,
          filePath: WORKSPACE_SECRET_VAULT_FILE,
        },
        "failed to reload encrypted workspace-secret vault — clearing live secrets",
      );
    }
  }
  replaceRecord(state.data.workspaceSecrets, next.workspaceSecrets);
}
