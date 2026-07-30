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

/**
 * Resolves the credential's subject from the route's params, or returns a Response to short-circuit
 * with (a 404 from requireWorkspace, say). Instance-wide credentials resolve to null.
 */
export type SubjectResolver<P> = (params: P) => Promise<CredentialSubject | Response>;

export interface CredentialHandlers<P> {
  /** Mints or rotates the secret. The plaintext is returned here and never again. */
  POST(request: Request, context: { params: Promise<P> }): Promise<Response>;
  /** Revokes the secret, leaving the channel's enabled flag alone. */
  DELETE(request: Request, context: { params: Promise<P> }): Promise<Response>;
  /** Opens or closes the channel: `{ enabled: boolean }`. */
  PATCH(request: Request, context: { params: Promise<P> }): Promise<Response>;
}

const NO_STORE = { "Cache-Control": "no-store" } as const;

async function readEnabled(request: Request): Promise<boolean | Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const enabled =
    body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>).enabled : undefined;
  if (typeof enabled !== "boolean") {
    return NextResponse.json({ error: "enabled must be a boolean" }, { status: 400 });
  }
  return enabled;
}

export function credentialHandlers<P>(kind: CredentialKind, resolveSubject: SubjectResolver<P>): CredentialHandlers<P> {
  async function subjectFor(context: { params: Promise<P> }): Promise<CredentialSubject | Response> {
    return resolveSubject(await context.params);
  }

  return {
    async POST(_request, context) {
      const subject = await subjectFor(context);
      if (subject instanceof Response) return subject;
      // The one moment the plaintext exists outside the caller's client. no-store keeps it out of
      // any intermediary cache.
      return NextResponse.json({ plain: mint(kind, subject) }, { headers: NO_STORE });
    },

    async DELETE(_request, context) {
      const subject = await subjectFor(context);
      if (subject instanceof Response) return subject;
      revoke(kind, subject);
      return NextResponse.json({ ok: true }, { headers: NO_STORE });
    },

    async PATCH(request, context) {
      const subject = await subjectFor(context);
      if (subject instanceof Response) return subject;
      const enabled = await readEnabled(request);
      if (enabled instanceof Response) return enabled;
      setEnabled(kind, subject, enabled);
      return NextResponse.json({ ok: true }, { headers: NO_STORE });
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
