// Trigger-neutral credential lifecycle operations. HTTP routes, CLI-facing routes and any later
// adapter share the same state preconditions without importing the persistence store directly.
import {
  mint,
  revoke,
  setEnabled,
  state,
  type CredentialKind,
  type CredentialState,
  type CredentialSubject,
} from "@/lib/infra/security/credentialStore";
import { AppError } from "@/lib/errors/appError";

export type CredentialIssueOperation = "generate" | "rotate";

export interface CredentialLifecycleStore {
  state(kind: CredentialKind, subject?: CredentialSubject): CredentialState;
  mint(kind: CredentialKind, subject?: CredentialSubject): string;
  revoke(kind: CredentialKind, subject?: CredentialSubject): void;
  setEnabled(kind: CredentialKind, subject: CredentialSubject, enabled: boolean): void;
}

export interface CredentialRevocationResult {
  ok: true;
  credentialKind: CredentialKind;
  subject: CredentialSubject;
  enabled: boolean;
  hasKey: false;
}

/**
 * The plaintext, and the channel as it stands once the key exists.
 *
 * The two axes travel with the key for the same reason revocation reports them: minting says nothing
 * about whether the channel is open, and a caller holding a `plain` with no answer to that has a
 * credential it cannot tell apart from a working one. It finds out when every call using it is
 * rejected, by which point the key has usually been handed on and there is nothing left pointing back
 * at the toggle. Issuing against a closed channel stays legal — it is the safe order, since the door
 * is opened after the key is delivered rather than before — so this is reported, not refused.
 */
export interface CredentialIssueResult {
  plain: string;
  enabled: boolean;
  hasKey: true;
}

function defaultStore(): CredentialLifecycleStore {
  return { state, mint, revoke, setEnabled };
}

export function validateCredentialIssueOperation(value: unknown): CredentialIssueOperation {
  if (value !== "generate" && value !== "rotate") {
    throw new AppError("INVALID_REQUEST", 'operation must be "generate" or "rotate"', {
      field: "operation",
    });
  }
  return value;
}

export function getCredentialState(
  kind: CredentialKind,
  subject: CredentialSubject = null,
  store: CredentialLifecycleStore = defaultStore(),
): CredentialState {
  return store.state(kind, subject);
}

/** Issues a read-once plaintext credential after enforcing generate/rotate state semantics. */
export function issueCredential(
  kind: CredentialKind,
  subject: CredentialSubject,
  requestedOperation: unknown,
  store: CredentialLifecycleStore = defaultStore(),
): CredentialIssueResult {
  const operation = validateCredentialIssueOperation(requestedOperation);
  const { hasKey } = store.state(kind, subject);
  const details = { credentialKind: kind, operation };

  if (operation === "generate" && hasKey) {
    throw new AppError("CREDENTIAL_ALREADY_CONFIGURED", "A credential already exists; rotate it instead.", details);
  }
  if (operation === "rotate" && !hasKey) {
    throw new AppError("CREDENTIAL_NOT_CONFIGURED", "No credential is configured; generate one instead.", details);
  }

  const plain = store.mint(kind, subject);
  // Read back rather than assumed, the same way revocation reads its result: `hasKey` is a confirmation
  // that the key reached the store, which is only worth printing if something looked.
  const after = store.state(kind, subject);
  return { plain, enabled: after.enabled, hasKey: true };
}

/** Revokes exactly one configured credential and reports both channel axes afterwards. */
export function revokeCredential(
  kind: CredentialKind,
  subject: CredentialSubject,
  store: CredentialLifecycleStore = defaultStore(),
): CredentialRevocationResult {
  if (!store.state(kind, subject).hasKey) {
    throw new AppError("CREDENTIAL_NOT_CONFIGURED", "No credential is configured; there is nothing to revoke.", {
      credentialKind: kind,
      operation: "revoke",
    });
  }

  store.revoke(kind, subject);
  const after = store.state(kind, subject);
  return {
    ok: true,
    credentialKind: kind,
    subject,
    enabled: after.enabled,
    hasKey: false,
  };
}

export function setCredentialEnabled(
  kind: CredentialKind,
  subject: CredentialSubject,
  value: unknown,
  store: CredentialLifecycleStore = defaultStore(),
): void {
  if (typeof value !== "boolean") {
    throw new AppError("INVALID_REQUEST", "enabled must be a boolean", { field: "enabled" });
  }
  store.setEnabled(kind, subject, value);
}
