// Per-workspace view of the proxy-injection vault. Secret values must stay recoverable because the
// proxy injects them. This vault and its master key are independent from the provider-key pair, so
// the sidecar can decrypt exactly this credential class and no other.
// The values are never exposed through the API — only metadata (name, allowed hosts) is returned.
// Each secret gets a stable opaque proxy token (e.g. __pxy_wsId_NAME__) injected into the
// container environment instead of the real value. The credential proxy swaps the token for
// the real value in outbound HTTPS headers.
import { createHash } from "crypto";
import { createAuditLogger } from "../logger";
import {
  WORKSPACE_SECRET_VAULT_FILE,
  assertWorkspaceSecretVaultAvailable,
  commitWorkspaceSecrets,
  reloadWorkspaceSecretVault,
  workspaceSecretRecords,
  type VaultWorkspaceSecretEntry,
  type VaultWorkspaceSecrets,
} from "./workspaceSecretVault";

const audit = createAuditLogger("secretStore");

// Exposed so the credential-proxy sidecar (a separate process) can watch it for changes.
export const SECRET_STORE_FILE = WORKSPACE_SECRET_VAULT_FILE;

type SecretEntry = VaultWorkspaceSecretEntry;
type Store = VaultWorkspaceSecrets;

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

const store: Store = workspaceSecretRecords();

/** Production startup calls this before accepting requests to prevent an empty fallback from
 * overwriting an existing store that could not be read or decrypted. */
export function assertSecretStoreAvailable(): void {
  assertWorkspaceSecretVaultAvailable();
}

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

function save(next: Store, context: { operation: string; wsId?: string; name?: string }): void {
  commitWorkspaceSecrets(next, context);
}

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

/**
 * Names a secret may not be injected under, because the container already uses them for something
 * the secret would silently replace.
 *
 * Secrets reach the container as `docker exec -e NAME=<token>`, and an exec-level `-e` outranks the
 * container's own environment. A secret named after the credential proxy's address or one of the
 * CA-trust variables (containerCredentials.ts) would therefore swap that wiring for an opaque token
 * and break the workspace's HTTPS in a way that looks like anything except a naming collision. The
 * rest are the shell's own footing — PATH, HOME, BASH_ENV and the loader vars — which decide what a
 * command resolves to before it runs.
 *
 * Lives here, next to the token derivation, because BOTH ends need it: validateSecret rejects these
 * names at the write boundary so a user gets a real error message, and buildExecEnv drops them at
 * the injection point so a secret stored before this rule existed can't still shadow the wiring on
 * every command. The write gate is the message; this is the boundary.
 *
 * GH_TOKEN is deliberately NOT reserved — buildExecEnv sets it from whichever secret is scoped to
 * github.com, so a user naming their token that outright is the expected case, not a collision.
 */
export const RESERVED_SECRET_NAMES: ReadonlySet<string> = new Set([
  // Credential-proxy routing and trust (buildRunEnv).
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "NODE_EXTRA_CA_CERTS",
  "REQUESTS_CA_BUNDLE",
  "CURL_CA_BUNDLE",
  "SSL_CERT_FILE",
  "GIT_SSL_CAINFO",
  // Shell and loader footing (Dockerfile.workspace).
  "PATH",
  "HOME",
  "BASH_ENV",
  "LD_PRELOAD",
  "LD_LIBRARY_PATH",
  "NVM_DIR",
  "PYENV_ROOT",
]);

export function setSecret(wsId: string, name: string, value: string, domains: string[]): void {
  const next = structuredClone(store);
  if (!next[wsId]) next[wsId] = {};
  const sanitized = sanitizeDomains(domains);
  next[wsId][name] = { value, createdAt: new Date().toISOString(), domains: sanitized } satisfies SecretEntry;
  save(next, { operation: "set_secret", wsId, name });
  audit.info({ wsId, name, event: "workspace_secret_set" }, "secret set");
}

export function deleteSecret(wsId: string, name: string): boolean {
  if (!store[wsId]?.[name]) return false;
  const next = structuredClone(store);
  delete next[wsId][name];
  if (Object.keys(next[wsId]).length === 0) delete next[wsId];
  save(next, { operation: "delete_secret", wsId, name });
  audit.info({ wsId, name, event: "workspace_secret_deleted" }, "secret deleted");
  return true;
}

export function listSecretMeta(wsId: string): { name: string; createdAt: string; domains: string[] }[] {
  const ws = store[wsId] ?? {};
  return Object.entries(ws).map(([name, e]) => ({ name, createdAt: e.createdAt, domains: e.domains }));
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
    for (const domain of entry.domains) {
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
  const next = structuredClone(store);
  delete next[wsId];
  save(next, { operation: "delete_workspace_secrets", wsId });
  audit.info({ wsId, event: "workspace_secrets_deleted" }, "all secrets deleted for workspace");
}

// Workspace ids that currently have any secret. Used by the credential-proxy sidecar to know
// which workspaces to (re)compute rules for after a reload.
export function listSecretWorkspaceIds(): string[] {
  return Object.keys(store);
}

// Re-read the workspace-secret vault into memory. The credential-proxy sidecar runs separately from
// the app that writes it, so it reloads on file change to keep injected values current. Failures fail
// closed: a missing or unreadable vault clears every live injection rule.
export function reloadSecretStore(): void {
  reloadWorkspaceSecretVault();
}
