// One HTTP representation for the shared workspace mutation result. Routes may translate their
// request shape (`enabled` to `internetAccess`, for example), but successful writes all return this
// receipt so UI, CLI and other callers observe the same authoritative server outcome.
//
// The receipt type is exported for the browser half (lib/client/workspaceReceipt.ts) to import as a
// type, so the two ends of the wire cannot drift.
import { NextResponse } from "next/server";
import { notFound } from "@/lib/api/guards";
import { getStore } from "@/lib/infra/services";
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
  applied: WorkspaceUpdateValues;
}

export function workspaceUpdateReceipt(result: UpdateWorkspaceResult): WorkspaceUpdateReceipt {
  const applied = Object.fromEntries(
    result.applied.map((field) => [field, result.values[field]]),
  ) as WorkspaceUpdateValues;
  return {
    ok: result.ok,
    workspaceId: result.workspaceId,
    applied,
  };
}

/** no-store because a receipt describes one moment of a mutable resource, not a cacheable read. */
export function receiptResponse(result: UpdateWorkspaceResult): NextResponse<WorkspaceUpdateReceipt> {
  return NextResponse.json(workspaceUpdateReceipt(result), { headers: { "Cache-Control": "no-store" } });
}

/** The two channels whose open/closed flag a credential endpoint's PATCH moves. */
export type WorkspaceAccessField = "workspaceApiAccess" | "workspaceMcpAccess";

/**
 * The workspace-level facts both channel routes put on every key receipt, so generate, rotate and
 * revoke answer with one field set and a caller reads the same shape whichever verb it called.
 *
 * `internetAccess` is egress and gates neither channel (lib/operations/workspace/access.ts). It is
 * here because a caller administering a workspace's external surface wants that surface in one answer
 * rather than in two calls, and as a plain boolean beside the two channel axes it cannot be mistaken
 * for the thing that decides whether a key is accepted — the receipt states all three and orders none.
 *
 * A subject that no longer resolves contributes nothing rather than failing: the mutation it describes
 * has already happened, and a receipt is the wrong place to discover a workspace was deleted mid-request.
 */
export function workspaceReceiptContext(subject: CredentialSubject): Record<string, unknown> {
  if (!subject) return {};
  const workspace = getStore().getWorkspace(subject);
  return workspace ? { internetAccess: workspace.internetAccess } : {};
}

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
