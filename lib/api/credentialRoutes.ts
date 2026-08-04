// Shared HTTP shape for the three credential-management endpoints (workspace API key, workspace MCP
// key, CLI/platform token). Each used to spell out its own POST/DELETE/PATCH over its own store;
// the verbs are identical, so they live here once and the routes stay thin adapters.
//
// GET is deliberately NOT generic: each endpoint returns different extras (publicBaseUrl, available
// skills), so abstracting it would cost more than it saves. Every GET spreads `state(kind, subject)`
// instead, which keeps the wire shape identical without pretending the responses are the same.
import { NextResponse } from "next/server";
import {
  mint,
  revoke,
  setEnabled,
  state,
  type CredentialKind,
  type CredentialSubject,
} from "@/lib/infra/security/credentialStore";
import type { WorkspaceAccessDetails } from "@/lib/operations/workspaceAccess";
import { appErrorResponse, errorResponse, readJsonObject } from "@/lib/api/errorResponse";
import { createLogger } from "@/lib/infra/logger";

const log = createLogger("api").child({ route: "credentials" });

/**
 * Resolves the credential's subject from the route's params, or returns a Response to short-circuit
 * with (a 404 from requireWorkspace, say). Instance-wide credentials resolve to null.
 */
export type SubjectResolver<P> = (params: P, request: Request) => Promise<CredentialSubject | Response>;

export interface CredentialHandlers<P> {
  /** Generates or rotates as requested in the body. The plaintext is returned here and never again. */
  POST(request: Request, context: { params: Promise<P> }): Promise<Response>;
  /**
   * Revokes the key unconditionally, leaving the channel's enabled flag alone. Answers with both axes
   * as they stand afterwards, so the caller sees a channel left open without a key.
   */
  DELETE(request: Request, context: { params: Promise<P> }): Promise<Response>;
  /** Opens or closes the channel: `{ enabled: boolean }`. */
  PATCH(request: Request, context: { params: Promise<P> }): Promise<Response>;
}

interface CredentialHandlerOptions {
  /**
   * Replaces the plain credential-store toggle for channels that have more to do than flip a flag.
   * Receives the request so any error it returns carries the same request id as every other response
   * on this route — an override that cannot correlate its own failures is worse than the default.
   */
  setEnabled?: (
    kind: CredentialKind,
    subject: CredentialSubject,
    enabled: boolean,
    request: Request,
  ) => void | Response | Promise<void | Response>;
  /**
   * Wire names for the two axes in the revocation receipt. A workspace channel passes the same pair the
   * workspace projection uses, so `revoke` and `get` describe one channel in one vocabulary instead of
   * renaming it between calls. Typed against WorkspaceAccessDetails so a rename there fails the build
   * here rather than quietly splitting the two apart again.
   *
   * Defaults to the credential routes' own `enabled` / `hasKey` for the instance-wide token, which has
   * no workspace field to borrow a name from.
   */
  axisFields?: { access: keyof WorkspaceAccessDetails; hasKey: keyof WorkspaceAccessDetails };
}

const NO_STORE = { "Cache-Control": "no-store" } as const;

type CredentialOperation = "generate" | "rotate";

async function readCredentialOperation(request: Request): Promise<CredentialOperation | Response> {
  const body = await readJsonObject(request);
  if (body instanceof Response) return body;
  if (body.operation !== "generate" && body.operation !== "rotate") {
    return errorResponse("INVALID_REQUEST", 'operation must be "generate" or "rotate"', {
      request,
      details: { field: "operation" },
    });
  }
  return body.operation;
}

/**
 * The whole rule set for minting, in two lines: each operation is refused only by the presence or
 * absence of the credential it acts on.
 *
 * The channel's enabled flag is deliberately absent. Access and credentials are independent axes —
 * a key presented against a disabled channel is already rejected by validate() in
 * credentialStore.ts, so gating here would add no safety and would cost the two orders that matter:
 * issuing a key before opening the channel, and destroying a leaked one after closing it.
 */
function credentialStateError(
  kind: CredentialKind,
  subject: CredentialSubject,
  operation: CredentialOperation,
  request: Request,
): Response | null {
  const { hasKey } = state(kind, subject);
  const details = { credentialKind: kind, operation };
  if (operation === "generate" && hasKey) {
    return errorResponse("CREDENTIAL_ALREADY_CONFIGURED", "A credential already exists; rotate it instead.", {
      request,
      details,
    });
  }
  if (operation === "rotate" && !hasKey) {
    return errorResponse("CREDENTIAL_NOT_CONFIGURED", "No credential is configured; generate one instead.", {
      request,
      details,
    });
  }
  return null;
}

async function readEnabled(request: Request): Promise<boolean | Response> {
  const body = await readJsonObject(request);
  if (body instanceof Response) return body;
  const enabled = body.enabled;
  if (typeof enabled !== "boolean") {
    return errorResponse("INVALID_REQUEST", "enabled must be a boolean", {
      request,
      details: { field: "enabled" },
    });
  }
  return enabled;
}

export function credentialHandlers<P>(
  kind: CredentialKind,
  resolveSubject: SubjectResolver<P>,
  options: CredentialHandlerOptions = {},
): CredentialHandlers<P> {
  async function subjectFor(request: Request, context: { params: Promise<P> }): Promise<CredentialSubject | Response> {
    return resolveSubject(await context.params, request);
  }

  const axisFields = options.axisFields ?? ({ access: "enabled", hasKey: "hasKey" } as const);

  function failed(request: Request, operation: string, err: unknown): Response {
    const expected = appErrorResponse(err, request);
    if (expected) return expected;
    log.error(
      {
        event: "credential_operation_failed",
        outcome: "credential_not_changed",
        code: "INTERNAL_ERROR",
        err,
        credentialKind: kind,
        operation,
      },
      "credential operation failed",
    );
    return errorResponse("INTERNAL_ERROR", "credential operation failed", { request });
  }

  return {
    async POST(request, context) {
      try {
        const subject = await subjectFor(request, context);
        if (subject instanceof Response) return subject;
        const operation = await readCredentialOperation(request);
        if (operation instanceof Response) return operation;
        const invalidState = credentialStateError(kind, subject, operation, request);
        if (invalidState) return invalidState;
        // Both operations write the same kind of record; naming which one you meant is what stops a
        // rotation from landing on a channel the caller thought was empty, and a generation from
        // silently replacing a key someone is still using. This is the one moment the plaintext
        // exists outside the caller's client, and no-store keeps it out of any intermediary cache.
        return NextResponse.json({ plain: mint(kind, subject) }, { headers: NO_STORE });
      } catch (err) {
        return failed(request, "mint", err);
      }
    },

    async DELETE(request, context) {
      try {
        const subject = await subjectFor(request, context);
        if (subject instanceof Response) return subject;
        // Unconditional and idempotent: revoking is how a leaked credential is destroyed, so it must
        // never depend on the channel being open, and revoking twice is a success both times.
        revoke(kind, subject);
        // Reports both axes afterwards rather than a bare ok, because revoking moves only one of them.
        // Destroying the last key leaves the channel open and keyless — reachable, and rejecting
        // everything — and a caller that got `{ ok: true }` had to ask a second time to find that out.
        // The timestamps stay out: they describe the key that was just destroyed, so a revocation
        // receipt is the one place they can only mislead.
        const after = state(kind, subject);
        return NextResponse.json(
          { ok: true, [axisFields.access]: after.enabled, [axisFields.hasKey]: after.hasKey },
          { headers: NO_STORE },
        );
      } catch (err) {
        return failed(request, "revoke", err);
      }
    },

    async PATCH(request, context) {
      try {
        const subject = await subjectFor(request, context);
        if (subject instanceof Response) return subject;
        const enabled = await readEnabled(request);
        if (enabled instanceof Response) return enabled;
        const response = options.setEnabled
          ? await options.setEnabled(kind, subject, enabled, request)
          : setEnabled(kind, subject, enabled);
        if (response instanceof Response) return response;
        return NextResponse.json({ ok: true }, { headers: NO_STORE });
      } catch (err) {
        return failed(request, "set_enabled", err);
      }
    },
  };
}

/**
 * The externally reachable origin for the workspace API and MCP endpoints, which are published on a
 * DNS-direct host (see deploy/Caddyfile.workspace-api) rather than the UI's. Null when unconfigured,
 * so the UI can fall back to showing a relative path instead of a wrong absolute one.
 */
export function publicBaseUrl(): string | null {
  const configured = process.env.WORKSPACE_API_DOMAIN?.trim();
  if (!configured) return null;
  return `https://${configured.replace(/^https?:\/\//, "").replace(/\/+$/, "")}`;
}
