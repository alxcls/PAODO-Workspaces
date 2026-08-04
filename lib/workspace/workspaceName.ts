// Workspace-name policy: validation, normalization, and the typed errors both the store and the
// API routes use. Kept separate from workspaceStore so the rules are unit-testable in isolation and
// so the routes can map an error to an HTTP status without importing the store.
//
// Two concerns live here:
//   - validateWorkspaceName: is this a well-formed *display* name? (rejects separators, control
//     chars, dot-names, over-length — the things that would make a name unsafe or confusing).
//   - normalizeForUniqueness: fold a name to the key we compare on so visually/semantically
//     equivalent names (case, Unicode form) can't coexist while agent routing is still name-based.
import path from "path";
import { WORKSPACES_ROOT } from "../infra/paths";
import { AppError } from "../errors/appError";

export const MAX_WORKSPACE_NAME_LENGTH = 100;

export type WorkspaceNameErrorCode = "WORKSPACE_NAME_INVALID" | "WORKSPACE_NAME_CONFLICT";

/** Thrown for both malformed names (INVALID) and collisions (CONFLICT); routes map code → status. */
export class WorkspaceNameError extends AppError {
  constructor(
    readonly code: WorkspaceNameErrorCode,
    message: string,
  ) {
    super(code, message);
    this.name = "WorkspaceNameError";
  }
}

// Control chars (C0 range + DEL) that must never appear in a filesystem-facing or displayed name.
const CONTROL_CHARS = /[\u0000-\u001F\u007F]/;

/**
 * Validates and cleans a user-supplied workspace name. Returns the canonical display form
 * (trimmed, NFC-normalized). Throws WorkspaceNameError("WORKSPACE_NAME_INVALID") on any violation.
 */
export function validateWorkspaceName(raw: string): string {
  const name = raw.trim().normalize("NFC");

  if (!name) {
    throw new WorkspaceNameError("WORKSPACE_NAME_INVALID", "Workspace name cannot be empty.");
  }
  if (name.length > MAX_WORKSPACE_NAME_LENGTH) {
    throw new WorkspaceNameError(
      "WORKSPACE_NAME_INVALID",
      `Workspace name cannot exceed ${MAX_WORKSPACE_NAME_LENGTH} characters.`,
    );
  }
  if (CONTROL_CHARS.test(name)) {
    throw new WorkspaceNameError("WORKSPACE_NAME_INVALID", "Workspace name cannot contain control characters.");
  }
  if (name.includes("/") || name.includes("\\")) {
    throw new WorkspaceNameError("WORKSPACE_NAME_INVALID", "Workspace name cannot contain path separators.");
  }
  if (name.startsWith(".")) {
    // Blocks ".", "..", and dotfile-style names that would otherwise shadow store metadata files.
    throw new WorkspaceNameError("WORKSPACE_NAME_INVALID", "Workspace name cannot start with a dot.");
  }
  // Defense in depth: even with the checks above, confirm the name can't escape the workspaces root.
  const dir = path.join(WORKSPACES_ROOT, name);
  if (!dir.startsWith(WORKSPACES_ROOT + path.sep)) {
    throw new WorkspaceNameError("WORKSPACE_NAME_INVALID", `Invalid workspace name: "${raw}".`);
  }
  return name;
}

/**
 * Folds a name to its uniqueness key: NFC + trim + case-insensitive. Two names with the same key
 * are treated as the same name (e.g. "Sales" and "sales", or Unicode-equivalent spellings), so they
 * cannot coexist while call_agent / the legacy /api/agent endpoint still address workspaces by name.
 */
export function normalizeForUniqueness(name: string): string {
  return name.trim().normalize("NFC").toLowerCase();
}
