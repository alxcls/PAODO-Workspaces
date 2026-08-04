// The browser half of the workspace update receipt (lib/api/workspaceUpdateReceipt.ts). Every
// mutation answers that one envelope, so every optimistic block adopts the server's confirmed values
// through this function rather than restating the envelope in its own inline cast — five private
// restatements of one shape is five places to miss when the shape moves.
import type { WorkspaceUpdateReceipt } from "@/lib/api/workspaceUpdateReceipt";

export type { WorkspaceUpdateReceipt };

/**
 * The canonical values a mutation confirmed, or an empty set when the response carries none — a body
 * that is not a receipt, or a field this build does not know about.
 *
 * Callers read each field with `?? theValueTheyAssumed`, so a missing one degrades to what was
 * optimistically rendered instead of blanking the control. The values themselves are trusted: they
 * come from our own typed routes, and re-checking each type here would only restate the contract
 * this module exists to hold in one place.
 */
export async function confirmedValues(response: Response): Promise<WorkspaceUpdateReceipt["values"]> {
  try {
    const body = (await response.json()) as Partial<WorkspaceUpdateReceipt> | null;
    return body?.values ?? {};
  } catch {
    return {};
  }
}
