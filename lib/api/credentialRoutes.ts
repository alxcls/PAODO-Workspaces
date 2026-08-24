// Shared HTTP shape for the three credential-management endpoints (workspace API key, workspace MCP
// key, CLI/platform token). Each used to spell out its own POST/DELETE/PATCH over its own store;
// the verbs are identical, so they live here once and the routes stay thin adapters.
//
// GET is deliberately NOT generic: each endpoint returns different extras (publicBaseUrl, available
// skills), so abstracting it would cost more than it saves. Every GET spreads the shared operation's
// credential state instead, which keeps the wire shape identical without pretending the responses are the same.
import { NextResponse } from "next/server";
import type { CredentialKind, CredentialSubject } from "@/lib/infra/security/credentialStore";
import { issueCredential, revokeCredential, setCredentialEnabled } from "@/lib/operations/credentials/manage";
import type { WorkspaceAccessDetails } from "@/lib/operations/workspace/access";
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
   * Revokes the key, leaving the channel's enabled flag alone. Refused when there is no key to
   * destroy. Answers with both axes as they stand afterwards, so the caller sees a channel left open
   * without a key.
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
   * Wire name for the key field in issue receipts. When supplied, the plaintext is returned under
   * this name instead of `plain`, so the receipt vocabulary matches the broader context (workspace
   * get, channel state). Absent for the instance-wide CLI token.
   */
  keyField?: string;
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
  /**
   * Extra facts about the subject to carry on every key receipt, so generate, rotate and revoke all
   * answer with the same set of fields and a caller reads one shape whichever verb it called.
   *
   * A workspace channel supplies its workspace's `internetAccess` here. That flag does not gate either
   * channel — egress and inbound are independent (lib/operations/workspace/access.ts) — and it is
   * reported rather than acted on for exactly that reason: a caller assembling a workspace's external
   * posture wants all of it in one answer, and getting it as a plain boolean beside the two axes is
   * what stops it being mistaken for the thing that made a key work or not.
   *
   * Absent for the instance-wide CLI token, which has no subject to describe.
   */
  receiptContext?: (subject: CredentialSubject) => Record<string, unknown>;
}

const NO_STORE = { "Cache-Control": "no-store" } as const;

async function readCredentialOperation(request: Request): Promise<unknown | Response> {
  const body = await readJsonObject(request);
  if (body instanceof Response) return body;
  return body.operation;
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
  // Not named `context`: every handler below already takes a route `context` parameter, which would
  // shadow this and turn each receipt into an opaque 500.
  const subjectFacts = (subject: CredentialSubject) => options.receiptContext?.(subject) ?? {};

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
        // Both operations write the same kind of record; naming which one you meant is what stops a
        // rotation from landing on a channel the caller thought was empty, and a generation from
        // silently replacing a key someone is still using. This is the one moment the plaintext
        // exists outside the caller's client, and no-store keeps it out of any intermediary cache.
        //
        // Answers with both axes, in the same words and beside the same context DELETE uses. Handing
        // back a bare `{ plain }` made the one receipt a caller cannot ask for twice the only one that
        // said nothing about whether the key it carries is currently accepted.
        const issued = issueCredential(kind, subject, operation);
        const keyFieldName = options.keyField || "plain";
        return NextResponse.json(
          {
            ok: true,
            [keyFieldName]: issued.plain,
            [axisFields.access]: issued.enabled,
            [axisFields.hasKey]: issued.hasKey,
            ...subjectFacts(subject),
          },
          { headers: NO_STORE },
        );
      } catch (err) {
        return failed(request, "mint", err);
      }
    },

    async DELETE(request, context) {
      try {
        const subject = await subjectFor(request, context);
        if (subject instanceof Response) return subject;
        // Refused when the slot is already empty, the same condition rotate refuses on: a success that
        // destroyed nothing reads exactly like one that destroyed a live key, so a caller clearing a
        // leak cannot tell whether this request is what ended it. The cost is that a retry after a
        // dropped response now answers 409 rather than confirming the key is gone — read the channel
        // back to tell that apart from a key that was never there.
        // Independent of the enabled flag either way: revoking is how a leaked credential is destroyed,
        // so it must never depend on the channel being open.
        // Reports both axes afterwards rather than a bare ok, because revoking moves only one of them.
        // Destroying the last key leaves the channel open and keyless — reachable, and rejecting
        // everything — and a caller that got `{ ok: true }` had to ask a second time to find that out.
        // The timestamps stay out: they describe the key that was just destroyed, so a revocation
        // receipt is the one place they can only mislead.
        const after = revokeCredential(kind, subject);
        return NextResponse.json(
          { ok: true, [axisFields.access]: after.enabled, [axisFields.hasKey]: after.hasKey, ...subjectFacts(subject) },
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
          : setCredentialEnabled(kind, subject, enabled);
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
 * DNS-direct host (see deploy/caddy/Caddyfile) rather than the UI's. Null when unconfigured,
 * so the UI can fall back to showing a relative path instead of a wrong absolute one.
 */
export function publicBaseUrl(): string | null {
  const configured = process.env.WORKSPACE_API_DOMAIN?.trim();
  if (!configured) return null;
  return `https://${configured.replace(/^https?:\/\//, "").replace(/\/+$/, "")}`;
}
