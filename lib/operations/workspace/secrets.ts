// Third-party secrets held for a workspace: the keys the credential proxy injects into the agent's
// outbound calls to named hosts. Listing and storing live together because they share one rule that
// neither could state alone — a scoped secret is inert while the workspace has no egress — and that
// rule is the whole reason `blockedBy` exists.
//
// Scoped deliberately to third-party secrets. The workspace's own API and MCP channels are a different
// capability with different gating (see workspaceAccess); egress does not block them, so nothing here
// applies to them.
import { getStore } from "@/lib/infra/services";
import { getCredentialProxy } from "@/lib/infra/proxy";
import {
  getWorkspaceRules,
  deleteSecret,
  listSecretMeta,
  normalizeDomain,
  setSecret,
} from "@/lib/infra/security/workspaceSecretStore";
import { WorkspaceUpdateError, WorkspaceUpdateFailure } from "./errors";
import type { WorkspaceLookup } from "./read";

// Exported so callers that publish an input contract (the CLI's schema) state the same rule this
// validates, instead of a copy that drifts.
export const SECRET_NAME_RE = /^[A-Z_][A-Z0-9_]*$/;
const SECRET_DOMAIN_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/;

/**
 * Names a secret may not take, because the container already uses them for something the secret
 * would silently replace.
 *
 * Secrets are injected per command as `docker exec -e NAME=<token>`, and an exec-level `-e` beats
 * the container's own environment. So a secret named after the proxy address or one of the CA-trust
 * variables (containerCredentials.ts) would swap that wiring for an opaque token and break the
 * workspace's HTTPS in a way that looks like anything but a naming collision. The rest are the
 * shell's own footing — PATH, HOME, BASH_ENV and the loader vars — which decide what a command even
 * resolves to before it runs.
 *
 * Exported for the same reason as SECRET_NAME_RE above: a caller that publishes this input contract
 * should state the same rule, not a copy that drifts from it.
 *
 * GH_TOKEN is deliberately NOT reserved — buildExecEnv sets it from whichever secret is scoped to
 * github.com, so a user naming their token that outright is the expected case, not a collision.
 */
export const RESERVED_SECRET_NAMES = new Set([
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

/**
 * One third-party secret held for a workspace: its name, when it was stored, and the hosts it may be
 * spent on. The secret VALUE is never part of this shape — it stays in workspaceSecretStore and is
 * injected by the credential proxy, so no caller of this operation can read it back.
 */
export interface ThirdPartySecret {
  name: string;
  createdAt: string;
  /** Hosts this credential is scoped to. Independent of `internetAccess`: both must allow the call. */
  domains: string[];
  /**
   * Present, and only present, when something stops this secret from working — today that is the
   * workspace having no egress. Absent means nothing blocks it. Derived here rather than left to
   * callers so a CLI or an agent reading `domains` next to `internetAccess: false` cannot mistake a
   * dormant secret for a live capability; omitted when clear so the common case carries no noise.
   */
  blockedBy?: "internetAccess";
}

/** A secret as a caller supplies it. The value is write-only and never read back out of this layer. */
export interface WorkspaceSecretInput {
  name: string;
  value: string;
  domains: string[];
}

/** The raw per-secret metadata the store hands back, before this module derives `blockedBy` from it. */
type SecretMeta = ReturnType<typeof listSecretMeta>[number];

/** Persistence for a secret, as one step: the proxy's rules are part of storing it, not a follow-up. */
export interface SecretStore {
  save(id: string, name: string, value: string, domains: string[]): Omit<ThirdPartySecret, "blockedBy">;
  read(id: string): SecretMeta[];
}

export interface SecretDeleter {
  delete(id: string, name: string): boolean;
}

/**
 * The one rule this file exists to state: a scoped secret cannot be spent while the workspace has no
 * egress. Spread into a secret rather than assigned, so the key is absent entirely when nothing blocks
 * it. Private — both callers that need it are in this file, which is why they are in this file.
 */
function blockedFor(internetAccess: boolean): { blockedBy?: "internetAccess" } {
  return internetAccess ? {} : { blockedBy: "internetAccess" };
}

function defaultSecretStore(): SecretStore & SecretDeleter {
  return {
    save: (id, name, value, domains) => {
      setSecret(id, name, value, domains);
      getCredentialProxy().setRules(id, getWorkspaceRules(id));
      const saved = listSecretMeta(id).find((item) => item.name === name);
      if (!saved) throw new WorkspaceUpdateFailure("failed to store third-party secret");
      return saved;
    },
    delete: (id, name) => {
      const deleted = deleteSecret(id, name);
      if (deleted) getCredentialProxy().setRules(id, getWorkspaceRules(id));
      return deleted;
    },
    read: listSecretMeta,
  };
}

/** Deletes a third-party secret and atomically refreshes the proxy's spend rules. */
export function deleteWorkspaceSecret(
  id: string,
  name: string,
  store: WorkspaceLookup = getStore(),
  secrets: SecretDeleter = defaultSecretStore(),
): boolean | null {
  if (!store.getWorkspace(id)) return null;
  return secrets.delete(id, name);
}

/**
 * Checks a supplied secret without storing it, and returns it as the checked shape. Pure, so a caller
 * can validate a whole request before its first write. Hosts are checked in normalized form because
 * that is the form they are stored and matched in — a caller may send `API.EXAMPLE.COM` and have it
 * accepted.
 *
 * Takes `unknown` rather than the input type, because this is the only field of the update contract
 * whose whole object crosses the wire: the transport hands over what the caller nested under `secret`,
 * so the shape is a claim to check here rather than one the compiler already established. Every
 * rejection is a typed WorkspaceUpdateError, so no malformed spelling can escape as a TypeError and
 * reach the caller as an opaque 500.
 */
export function validateSecret(input: unknown): WorkspaceSecretInput {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new WorkspaceUpdateError("secret must be an object with name, value and domains");
  }
  const { name, value, domains } = input as Partial<Record<keyof WorkspaceSecretInput, unknown>>;

  // Each check leads with the type so a missing field and a wrong-typed one give the same answer: both
  // are a field the caller has not usably supplied, and the message that names the accepted form is the
  // one they need either way.
  if (typeof name !== "string" || !SECRET_NAME_RE.test(name)) {
    throw new WorkspaceUpdateError("name must be uppercase letters, digits, and underscores (e.g. OPENAI_KEY)");
  }
  if (RESERVED_SECRET_NAMES.has(name)) {
    throw new WorkspaceUpdateError(`${name} is used by the workspace container itself — choose another name`);
  }
  if (typeof value !== "string" || !value.trim()) throw new WorkspaceUpdateError("value required");
  if (!Array.isArray(domains) || domains.length === 0) {
    throw new WorkspaceUpdateError("add at least one allowed host");
  }
  for (const raw of domains) {
    if (typeof raw !== "string" || !SECRET_DOMAIN_RE.test(normalizeDomain(raw))) {
      throw new WorkspaceUpdateError("each allowed host must be a hostname the key is sent to (e.g. api.openai.com)");
    }
  }
  return { name, value, domains };
}

/**
 * The secrets held for a workspace — names, dates and scoped hosts, never values. The home page hides
 * this block while internetAccess is off; this operation reports the secrets either way, because they
 * still exist and an operator auditing a workspace needs to see them, with `blockedBy` marking any
 * that cannot currently be spent.
 */
export function listWorkspaceSecrets(
  id: string,
  store: WorkspaceLookup = getStore(),
  secrets: Pick<SecretStore, "read"> = defaultSecretStore(),
): ThirdPartySecret[] {
  const workspace = store.getWorkspace(id);
  if (!workspace) return [];
  const blocked = blockedFor(workspace.internetAccess);
  return secrets.read(id).map(({ name, createdAt, domains }) => ({ name, createdAt, domains, ...blocked }));
}

/**
 * Stores a validated secret and reports it back in the same shape the list query returns — including
 * `blockedBy`, so a caller that has just added a key to a workspace with no egress learns immediately
 * that it will not be spent yet. Validate with validateSecret first; this assumes a checked input.
 */
export function storeWorkspaceSecret(
  id: string,
  input: WorkspaceSecretInput,
  store: WorkspaceLookup = getStore(),
  secrets: SecretStore = defaultSecretStore(),
): ThirdPartySecret {
  const saved = secrets.save(id, input.name, input.value, input.domains);
  // Read egress back after the write rather than before: a workspace that vanished mid-update reads
  // as blocked, which is the truthful answer for a secret that can no longer be spent at all.
  return { ...saved, ...blockedFor(store.getWorkspace(id)?.internetAccess ?? false) };
}
