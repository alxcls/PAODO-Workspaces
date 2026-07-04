// Per-workspace secret store. Secret values must stay recoverable (the proxy injects them), so
// they are stored reversibly — but encrypted at rest (AES-256-GCM, secretsEncryption.ts) so
// backups/snapshots of data/ don't expose plaintext. Legacy plaintext files are migrated to the
// encrypted envelope on first load.
// The values are never exposed through the API — only metadata (name, domain) is returned.
// Each secret gets a stable opaque proxy token (e.g. __pxy_wsId_NAME__) injected into the
// container environment instead of the real value. The credential proxy swaps the token for
// the real value in outbound HTTPS headers.
import { readFileSync } from "fs";
import path from "path";
import { WORKSPACES_ROOT } from "../paths";
import { atomicSaveJson } from "../jsonPersist";
import { createLogger } from "../logger";
import { isEncEnvelope, encryptToEnvelope, decryptFromEnvelope } from "./secretsEncryption";

const log = createLogger("secretStore");

const FILE = path.join(WORKSPACES_ROOT, ".workspace-secrets.json");
// Exposed so the credential-proxy sidecar (a separate process) can watch it for changes.
export const SECRET_STORE_FILE = FILE;

interface SecretEntry {
  value: string;
  createdAt: string;
  // Host the value may be injected into (e.g. "api.openai.com"). The proxy only swaps
  // the token for the real value on requests to this host; every other host is a plain
  // tunnel. A secret with no domain is never injected (nothing to intercept).
  domain: string;
}

type Store = Record<string, Record<string, SecretEntry>>;

// A domain and the tokens the proxy may inject on requests to that domain.
export interface DomainRule {
  domain: string;
  tokenMap: Map<string, string>;
}

// Reduce user input to a bare hostname: strip scheme, path, port, and trailing dot.
export function normalizeDomain(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, "")
    .replace(/\/.*$/, "")
    .replace(/:\d+$/, "")
    .replace(/\.$/, "");
}

const g = global as typeof global & { _workspaceSecrets?: Store };
let migrateLegacy = false;
if (!g._workspaceSecrets) {
  g._workspaceSecrets = {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(FILE, "utf-8"));
    if (isEncEnvelope(parsed)) {
      g._workspaceSecrets = JSON.parse(decryptFromEnvelope(parsed)) as Store;
    } else {
      // Legacy plaintext store from before encryption at rest — load it, then re-save encrypted
      // below so the plaintext doesn't linger on disk until the next mutation.
      g._workspaceSecrets = parsed as Store;
      migrateLegacy = true;
    }
  } catch (err) {
    // ENOENT is the normal first-run case. Anything else (tampered/corrupt ciphertext, wrong
    // key) fails closed: start empty rather than crash; the next setSecret overwrites the file.
    // The error log is the recovery signal.
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      log.error({ err, event: "secret_store_load_failed" }, "failed to load secret store — starting empty");
    }
  }
}
const store = g._workspaceSecrets;

function save() {
  try {
    atomicSaveJson(FILE, encryptToEnvelope(JSON.stringify(store)));
  } catch (err) {
    log.error({ err }, "failed to save secret store");
    throw err;
  }
}

if (migrateLegacy) {
  try {
    save();
    log.info("migrated plaintext secret store to encrypted format");
  } catch (err) {
    log.error({ err }, "failed to re-save secret store encrypted");
  }
}

export function proxyToken(wsId: string, name: string): string {
  return `__pxy_${wsId}_${name}__`;
}

export function setSecret(wsId: string, name: string, value: string, domain: string): void {
  if (!store[wsId]) store[wsId] = {};
  store[wsId][name] = { value, createdAt: new Date().toISOString(), domain: normalizeDomain(domain) };
  save();
  log.info({ wsId, name }, "secret set");
}

export function deleteSecret(wsId: string, name: string): boolean {
  if (!store[wsId]?.[name]) return false;
  delete store[wsId][name];
  if (Object.keys(store[wsId]).length === 0) delete store[wsId];
  save();
  log.info({ wsId, name }, "secret deleted");
  return true;
}

export function listSecretMeta(wsId: string): { name: string; createdAt: string; domain: string }[] {
  const ws = store[wsId] ?? {};
  return Object.entries(ws).map(([name, e]) => ({ name, createdAt: e.createdAt, domain: e.domain ?? "" }));
}

// Returns the proxy rules for a workspace, grouped by domain. Secrets without a domain are
// omitted — the proxy has no way to deliver them, so they must never widen what gets MITM'd.
export function getWorkspaceRules(wsId: string): DomainRule[] {
  const ws = store[wsId] ?? {};
  const byDomain = new Map<string, Map<string, string>>();
  for (const [name, entry] of Object.entries(ws)) {
    if (!entry.domain) continue;
    let tokenMap = byDomain.get(entry.domain);
    if (!tokenMap) {
      tokenMap = new Map();
      byDomain.set(entry.domain, tokenMap);
    }
    tokenMap.set(proxyToken(wsId, name), entry.value);
  }
  return [...byDomain].map(([domain, tokenMap]) => ({ domain, tokenMap }));
}

export function deleteAllForWorkspace(wsId: string): void {
  if (!store[wsId]) return;
  delete store[wsId];
  save();
  log.info({ wsId }, "all secrets deleted for workspace");
}

// Workspace ids that currently have any secret. Used by the credential-proxy sidecar to know
// which workspaces to (re)compute rules for after a reload.
export function listSecretWorkspaceIds(): string[] {
  return Object.keys(store);
}

// Re-read the on-disk secret store into memory. The credential-proxy sidecar runs in a separate
// process from the app that writes this file, so it reloads on file change to keep injected values
// current. Mutates `store` in place (it is a fixed reference). Failures fail closed: a missing file
// is the normal empty case; a corrupt/tampered envelope leaves an empty store rather than throwing.
export function reloadSecretStore(): void {
  let next: Store = {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(FILE, "utf-8"));
    next = isEncEnvelope(parsed) ? (JSON.parse(decryptFromEnvelope(parsed)) as Store) : (parsed as Store);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      log.error({ err, event: "secret_store_reload_failed" }, "failed to reload secret store");
    }
  }
  for (const k of Object.keys(store)) delete store[k];
  Object.assign(store, next);
}
