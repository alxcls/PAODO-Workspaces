// Per-workspace secret store. Secrets are stored as plaintext (they must be recovered for
// injection) but only written to disk under data/ which is never committed to git.
// The values are never exposed through the API — only metadata (name, domain) is returned.
// Each secret gets a stable opaque proxy token (e.g. __pxy_wsId_NAME__) injected into the
// container environment instead of the real value. The credential proxy swaps the token for
// the real value in outbound HTTPS headers.
import { readFileSync } from "fs";
import path from "path";
import { WORKSPACES_ROOT } from "../paths";
import { atomicSaveJson } from "../jsonPersist";
import { createLogger } from "../logger";

const log = createLogger("secretStore");

const FILE = path.join(WORKSPACES_ROOT, ".workspace-secrets.json");

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
if (!g._workspaceSecrets) {
  try {
    g._workspaceSecrets = JSON.parse(readFileSync(FILE, "utf-8")) as Store;
  } catch {
    g._workspaceSecrets = {};
  }
}
const store = g._workspaceSecrets;

function save() {
  try {
    atomicSaveJson(FILE, store);
  } catch (err) {
    log.error({ err }, "failed to save secret store");
    throw err;
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
