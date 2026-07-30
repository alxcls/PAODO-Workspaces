// One store for every minted bearer secret PAODO issues: the per-workspace agent API key, the
// per-workspace MCP secret, and the instance-wide CLI/platform token. Before this existed the three
// were separate copy-pasted modules (apiKeyStore / mcpConfigStore / platformTokenStore) with three
// spellings of the same lifecycle, which is how the platform token ended up with no revoke at all.
//
// The unit is one record per (kind, subject) — one API key per workspace, one MCP secret per
// workspace, one CLI token for the instance — keyed naturally, so there are no synthetic ids and no
// lookup indirection. Secrets are stored only as SHA-256 hashes and the hash never leaves this
// module: callers get `state()`, which cannot expose one.
//
// Deliberately NOT here: the UI's Basic-Auth login (a human credential, see wsSession.ts) and
// workspaceSecretStore (reversibly encrypted values the proxy must recover — a different primitive).
// Which routes a credential may reach is authorization, not identity, and lives in
// platformAccessPolicy.ts.
import { createHash, randomBytes, timingSafeEqual } from "crypto";
import path from "path";
import { WORKSPACES_ROOT } from "../paths";
import { atomicSaveJson, readJson } from "../jsonPersist";
import { globalSingleton } from "../globalSingleton";
import { createAuditLogger, createLogger } from "../logger";

const log = createLogger("credentials");
const audit = createAuditLogger("credentials");
const FILE = path.join(WORKSPACES_ROOT, ".credentials.json");

export type CredentialKind = "workspace-api" | "workspace-mcp" | "platform";

/** Workspace id for the per-workspace kinds; null for the instance-wide platform token. */
export type CredentialSubject = string | null;

/** What callers may see. Deliberately has no hash field, so no route can leak one. */
export interface CredentialState {
  enabled: boolean;
  hasSecret: boolean;
  createdAt: string | null;
  lastUsedAt: string | null;
}

interface CredentialRecord {
  hash: string | null;
  enabled: boolean;
  createdAt: string;
  lastUsedAt: string | null;
}

// Prefixes are worth keeping: a leaked secret stays identifiable at a glance in a log, a bug report
// or a secret scanner. Derived from `kind` here rather than hardcoded at three mint sites.
const PREFIX: Record<CredentialKind, string> = {
  "workspace-api": "sk_",
  "workspace-mcp": "mcp_",
  platform: "cli_",
};

const WORKSPACE_KINDS: readonly CredentialKind[] = ["workspace-api", "workspace-mcp"];

// A hash written more than this long ago is refreshed on use. Every save rewrites the whole file, so
// an exact lastUsedAt would mean a disk write per authenticated request; coarse is the right trade.
const LAST_USED_REFRESH_MS = 60_000;

const store = globalSingleton<Record<string, CredentialRecord>>("credentials", () =>
  readJson<Record<string, CredentialRecord>>(FILE, {}),
);

// `platform` is instance-wide so it takes no subject; the workspace kinds require one. Passing the
// wrong combination is a programming error, not a runtime condition — fail loudly rather than
// silently reading or writing the wrong record.
function recordKey(kind: CredentialKind, subject: CredentialSubject): string {
  if (kind === "platform") {
    if (subject) throw new Error("The platform credential is instance-wide and takes no subject.");
    return "platform";
  }
  if (!subject) throw new Error(`The ${kind} credential requires a workspace id.`);
  return `${kind}:${subject}`;
}

function save(operation: string, kind: CredentialKind): void {
  try {
    atomicSaveJson(FILE, store);
  } catch (err) {
    log.error(
      {
        event: "credential_store_save_failed",
        outcome: "credential_change_not_persisted",
        err,
        operation,
        kind,
        filePath: FILE,
      },
      "failed to save credential store",
    );
    throw err;
  }
}

function hashSecret(plain: string): string {
  return createHash("sha256").update(plain).digest("hex");
}

/** Mints (or rotates) the secret for this credential and returns the plaintext once. Enables it. */
export function mint(kind: CredentialKind, subject: CredentialSubject = null): string {
  const key = recordKey(kind, subject);
  const plain = PREFIX[kind] + randomBytes(32).toString("hex");
  store[key] = {
    hash: hashSecret(plain),
    enabled: true,
    createdAt: new Date().toISOString(),
    lastUsedAt: null,
  };
  save("mint", kind);
  audit.info({ kind, subject, event: "credential_minted" }, "credential minted");
  return plain;
}

/**
 * Destroys the secret so it can never validate again, keeping the record's enabled flag. Revoking
 * and disabling are different intents: revoke invalidates the secret, disable closes the channel.
 */
export function revoke(kind: CredentialKind, subject: CredentialSubject = null): void {
  const key = recordKey(kind, subject);
  const record = store[key];
  if (record) {
    record.hash = null;
    save("revoke", kind);
  }
  audit.info({ kind, subject, event: "credential_revoked" }, "credential revoked");
}

/**
 * Turns the access channel on or off. A channel may be enabled before a secret exists — that is the
 * UI's "enabled, secret required" state — but a disabled channel rejects every secret.
 */
export function setEnabled(kind: CredentialKind, subject: CredentialSubject, enabled: boolean): void {
  const key = recordKey(kind, subject);
  store[key] = {
    hash: store[key]?.hash ?? null,
    enabled,
    createdAt: store[key]?.createdAt ?? new Date().toISOString(),
    lastUsedAt: store[key]?.lastUsedAt ?? null,
  };
  save("set_enabled", kind);
  audit.info({ kind, subject, enabled, event: "credential_enabled_changed" }, "credential enabled state changed");
}

export function state(kind: CredentialKind, subject: CredentialSubject = null): CredentialState {
  const record = store[recordKey(kind, subject)];
  return {
    enabled: record?.enabled ?? false,
    hasSecret: (record?.hash ?? null) !== null,
    createdAt: record?.createdAt ?? null,
    lastUsedAt: record?.lastUsedAt ?? null,
  };
}

/** Forgets the credential entirely. For cleanup, not revocation — prefer revoke() to invalidate. */
export function remove(kind: CredentialKind, subject: CredentialSubject = null): void {
  const key = recordKey(kind, subject);
  if (!(key in store)) return;
  delete store[key];
  save("remove", kind);
  audit.info({ kind, subject, event: "credential_removed" }, "credential removed");
}

/** Drops every credential belonging to a workspace. Called when the workspace itself is deleted. */
export function removeWorkspace(subject: string): void {
  for (const kind of WORKSPACE_KINDS) remove(kind, subject);
}

function touchLastUsed(key: string, record: CredentialRecord): void {
  const now = Date.now();
  const previous = record.lastUsedAt ? Date.parse(record.lastUsedAt) : 0;
  if (Number.isFinite(previous) && now - previous < LAST_USED_REFRESH_MS) return;
  record.lastUsedAt = new Date(now).toISOString();
  try {
    atomicSaveJson(FILE, store);
  } catch (err) {
    // Best-effort only: last-used is telemetry, and a disk problem must not turn a valid
    // authentication into a failure. Deliberately does not use save(), which rethrows.
    log.warn(
      {
        event: "credential_last_used_not_persisted",
        outcome: "authentication_succeeded_telemetry_lost",
        err,
        credential: key,
        filePath: FILE,
      },
      "failed to persist credential last-used timestamp",
    );
  }
}

/**
 * The authentication chokepoint for every programmatic caller. Fails closed on every uncertain
 * state: unknown credential, disabled channel, revoked secret, empty input, or a stored hash that
 * is not a well-formed SHA-256 digest (a hand-edited or truncated file must deny, not throw).
 */
export function validate(kind: CredentialKind, subject: CredentialSubject, plain: string): boolean {
  const key = recordKey(kind, subject);
  const record = store[key];
  if (!record || !record.enabled || !record.hash || !plain) return false;

  const presented = Buffer.from(hashSecret(plain));
  const stored = Buffer.from(record.hash);
  // timingSafeEqual throws on a length mismatch, which only a corrupted store can produce here.
  if (presented.byteLength !== stored.byteLength) return false;
  if (!timingSafeEqual(presented, stored)) return false;

  touchLastUsed(key, record);
  return true;
}
