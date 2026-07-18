// Per-workspace secret store. Secret values must stay recoverable (the proxy injects them), so
// they are stored reversibly — but encrypted at rest (AES-256-GCM, secretsEncryption.ts) so
// backups/snapshots of data/ don't expose plaintext. Legacy plaintext files are migrated to the
// encrypted envelope on first load.
// The values are never exposed through the API — only metadata (name, allowed hosts) is returned.
// Each secret gets a stable opaque proxy token (e.g. __pxy_wsId_NAME__) injected into the
// container environment instead of the real value. The credential proxy swaps the token for
// the real value in outbound HTTPS headers.
import { readFileSync } from "fs";
import { createHash } from "crypto";
import path from "path";
import { WORKSPACES_ROOT } from "../paths";
import { atomicSaveJson } from "../jsonPersist";
import { createAuditLogger, createLogger } from "../logger";
import { isEncEnvelope, encryptToEnvelope, decryptFromEnvelope } from "./secretsEncryption";

const log = createLogger("secretStore");
const audit = createAuditLogger("secretStore");

const FILE = path.join(WORKSPACES_ROOT, ".workspace-secrets.json");
// Exposed so the credential-proxy sidecar (a separate process) can watch it for changes.
export const SECRET_STORE_FILE = FILE;

interface SecretEntry {
  value: string;
  createdAt: string;
  // Hosts the value may be injected into (e.g. ["api.openai.com", "github.com"]). The proxy only
  // swaps the token for the real value on requests to these hosts; every other host is a plain
  // tunnel. A secret with no hosts configured is never injected (nothing to intercept).
  domains?: string[]; // present on new entries; legacy entries used singular `domain` below
  domain?: string;
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

function sanitizeDomains(domains: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of domains) {
    const normalized = normalizeDomain(raw ?? "");
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out.sort();
}

function coerceEntryDomains(entry: SecretEntry): string[] {
  if (entry.domains?.length) {
    entry.domains = sanitizeDomains(entry.domains);
    if (entry.domains.length) return entry.domains;
  }
  const legacy = entry.domain ? [entry.domain] : [];
  const sanitized = sanitizeDomains(legacy);
  entry.domains = sanitized;
  delete entry.domain;
  return sanitized;
}

function upgradeStoreDomains(target: Store): void {
  for (const ws of Object.values(target)) {
    for (const entry of Object.values(ws)) {
      coerceEntryDomains(entry);
    }
  }
}

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
    upgradeStoreDomains(store);
    save();
    audit.info({ event: "secret_store_encrypted" }, "migrated plaintext secret store to encrypted format");
  } catch (err) {
    log.error({ err }, "failed to re-save secret store encrypted");
  }
}
upgradeStoreDomains(store);

// Versioned opaque values placed in the container instead of real secret values.  They must be
// safe to pass to common CLIs as well as HTTP clients: a surprising number validate `--token`
// locally and reject punctuation before the request reaches our proxy.  `p` + SHA-256 hex is
// deliberately alphanumeric-only, stable, and long enough to be unambiguous in a request.
//
// This is not an authentication secret.  Credential injection is separately gated by the
// container's Proxy-Authorization workspace credential, and a token only maps to a real value for
// its exact allowlisted host.
export const PROXY_TOKEN_FORMAT_VERSION = "v2";

export function proxyToken(wsId: string, name: string): string {
  const digest = createHash("sha256").update(`${PROXY_TOKEN_FORMAT_VERSION}\0${wsId}\0${name}`).digest("hex");
  return `p${digest}`;
}

export function setSecret(wsId: string, name: string, value: string, domains: string[]): void {
  if (!store[wsId]) store[wsId] = {};
  const sanitized = sanitizeDomains(domains);
  store[wsId][name] = { value, createdAt: new Date().toISOString(), domains: sanitized };
  save();
  audit.info({ wsId, name, event: "workspace_secret_set" }, "secret set");
}

export function deleteSecret(wsId: string, name: string): boolean {
  if (!store[wsId]?.[name]) return false;
  delete store[wsId][name];
  if (Object.keys(store[wsId]).length === 0) delete store[wsId];
  save();
  audit.info({ wsId, name, event: "workspace_secret_deleted" }, "secret deleted");
  return true;
}

export function listSecretMeta(wsId: string): { name: string; createdAt: string; domains: string[] }[] {
  const ws = store[wsId] ?? {};
  // Entries are already normalized to `domains` by upgradeStoreDomains at load/reload/migrate, so
  // read the field directly rather than re-coercing on every read.
  return Object.entries(ws).map(([name, e]) => ({ name, createdAt: e.createdAt, domains: e.domains ?? [] }));
}

// Pick which secret should back git/gh auth for github.com. Selection is keyed off the scoped
// DOMAIN, not the secret's name, so a user may name their token anything. Its opaque proxy token is
// injected as GH_TOKEN into the container, where a static git credential helper and gh both consume
// it. Tiebreak when several secrets are scoped to github.com: exact GITHUB_TOKEN, then GH_TOKEN,
// then any name mentioning GITHUB/GH, else the first such secret. Returns null when none qualify.
export function selectGithubTokenSecret(metas: { name: string; domains: string[] }[]): string | null {
  const candidates = metas.filter((m) => m.domains.includes("github.com")).map((m) => m.name);
  if (candidates.length === 0) return null;
  return (
    candidates.find((n) => n === "GITHUB_TOKEN") ??
    candidates.find((n) => n === "GH_TOKEN") ??
    // Token-style boundary match (GH_TOKEN, MY_GITHUB_PAT) — not incidental substrings (HIGH_SCORE).
    candidates.find((n) => /(^|_)(GITHUB|GH)(_|$)/.test(n)) ??
    candidates[0]
  );
}

// Returns the proxy rules for a workspace, grouped by domain. Secrets without a domain are
// omitted — the proxy has no way to deliver them, so they must never widen what gets MITM'd.
export function getWorkspaceRules(wsId: string): DomainRule[] {
  const ws = store[wsId] ?? {};
  const byDomain = new Map<string, Map<string, string>>();
  for (const [name, entry] of Object.entries(ws)) {
    for (const domain of entry.domains ?? []) {
      if (!domain) continue;
      let tokenMap = byDomain.get(domain);
      if (!tokenMap) {
        tokenMap = new Map();
        byDomain.set(domain, tokenMap);
      }
      tokenMap.set(proxyToken(wsId, name), entry.value);
    }
  }
  return [...byDomain].map(([domain, tokenMap]) => ({ domain, tokenMap }));
}

export function deleteAllForWorkspace(wsId: string): void {
  if (!store[wsId]) return;
  delete store[wsId];
  save();
  audit.info({ wsId, event: "workspace_secrets_deleted" }, "all secrets deleted for workspace");
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
  upgradeStoreDomains(next);
  for (const k of Object.keys(store)) delete store[k];
  Object.assign(store, next);
}
