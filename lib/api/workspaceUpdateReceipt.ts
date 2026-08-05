// One HTTP representation for the shared workspace mutation result. Routes may translate their
// request shape (`enabled` to `internetAccess`, for example), but successful writes all return this
// receipt so UI, CLI and other callers observe the same authoritative server outcome.
//
// The receipt type is exported for the browser half (lib/client/workspaceReceipt.ts) to import as a
// type, so the two ends of the wire cannot drift.
import { NextResponse } from "next/server";
import { notFound } from "@/lib/api/guards";
import type { CredentialKind, CredentialSubject } from "@/lib/infra/security/credentialStore";
import {
  updateWorkspace,
  type UpdateWorkspaceInput,
  type UpdateWorkspaceResult,
  type WorkspaceUpdateValues,
} from "@/lib/operations/workspace/update";

export interface WorkspaceUpdateReceipt {
  ok: true;
  workspaceId: string;
  applied: string[];
  values: WorkspaceUpdateValues;
}

export function workspaceUpdateReceipt(result: UpdateWorkspaceResult): WorkspaceUpdateReceipt {
  return {
    ok: result.ok,
    workspaceId: result.workspaceId,
    applied: result.applied,
    values: result.values,
  };
}

/** no-store because a receipt describes one moment of a mutable resource, not a cacheable read. */
export function receiptResponse(result: UpdateWorkspaceResult): NextResponse<WorkspaceUpdateReceipt> {
  return NextResponse.json(workspaceUpdateReceipt(result), { headers: { "Cache-Control": "no-store" } });
}

/** The two channels whose open/closed flag a credential endpoint's PATCH moves. */
export type WorkspaceAccessField = "workspaceApiAccess" | "workspaceMcpAccess";

/**
 * The channel-toggle half of a credential endpoint's PATCH, so the api-key and mcp-config routes
 * differ only in which field they name. Going through updateWorkspace is what makes the toggle and a
 * PATCH on the workspace itself report the channel identically; the receipt never carries a key,
 * because minting one is POST's job.
 */
export function channelSetEnabled(field: WorkspaceAccessField) {
  return async (
    _kind: CredentialKind,
    subject: CredentialSubject,
    enabled: boolean,
    request: Request,
  ): Promise<Response> => {
    // Both channels are per-workspace, so a null subject is an instance-wide credential wired to the
    // wrong handler. Refusing here keeps that a 404 rather than an update against an unnamed record.
    if (!subject) return notFound(request);
    const input: UpdateWorkspaceInput =
      field === "workspaceApiAccess" ? { workspaceApiAccess: enabled } : { workspaceMcpAccess: enabled };
    const result = await updateWorkspace(subject, input);
    if (!result) return notFound(request);
    return receiptResponse(result);
  };
}
