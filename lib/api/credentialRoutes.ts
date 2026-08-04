// Shared HTTP shape for the three credential-management endpoints (workspace API key, workspace MCP
// secret, CLI/platform token). Each used to spell out its own POST/DELETE/PATCH over its own store;
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
  type CredentialKind,
  type CredentialSubject,
} from "@/lib/infra/security/credentialStore";
import { appErrorResponse, errorResponse, readJsonObject } from "@/lib/api/errorResponse";
import { createLogger } from "@/lib/infra/logger";

const log = createLogger("api").child({ route: "credentials" });

/**
 * Resolves the credential's subject from the route's params, or returns a Response to short-circuit
 * with (a 404 from requireWorkspace, say). Instance-wide credentials resolve to null.
 */
export type SubjectResolver<P> = (params: P, request: Request) => Promise<CredentialSubject | Response>;

export interface CredentialHandlers<P> {
  /** Mints or rotates the secret. The plaintext is returned here and never again. */
  POST(request: Request, context: { params: Promise<P> }): Promise<Response>;
  /** Revokes the secret, leaving the channel's enabled flag alone. */
  DELETE(request: Request, context: { params: Promise<P> }): Promise<Response>;
  /** Opens or closes the channel: `{ enabled: boolean }`. */
  PATCH(request: Request, context: { params: Promise<P> }): Promise<Response>;
}

interface CredentialHandlerOptions {
  setEnabled?: (
    kind: CredentialKind,
    subject: CredentialSubject,
    enabled: boolean,
  ) => void | Response | Promise<void | Response>;
}

const NO_STORE = { "Cache-Control": "no-store" } as const;

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
        // The one moment the plaintext exists outside the caller's client. no-store keeps it out of
        // any intermediary cache.
        return NextResponse.json({ plain: mint(kind, subject) }, { headers: NO_STORE });
      } catch (err) {
        return failed(request, "mint", err);
      }
    },

    async DELETE(request, context) {
      try {
        const subject = await subjectFor(request, context);
        if (subject instanceof Response) return subject;
        revoke(kind, subject);
        return NextResponse.json({ ok: true }, { headers: NO_STORE });
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
          ? await options.setEnabled(kind, subject, enabled)
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
