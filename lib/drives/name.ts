// Drive-name policy: the rules, and the typed error both the store and the API routes use.
//
// Kept out of the registry (store.ts) for the same reason lib/workspace/name.ts is kept out of the
// workspace store: a route has to map a name violation to a status without importing the store, and
// the rules stay unit-testable without touching disk.
//
// The name never reaches the drive's own path — that is keyed by UUID, so renaming is safe — but
// drive_download writes into the workspace at downloads/<drive-name>/, so it must be a safe single
// path segment.
import { AppError } from "../errors/appError";

export const MAX_DRIVE_NAME_LENGTH = 100;

/** Thrown for a name the caller has to fix, as opposed to a disk or I/O failure. */
export class DriveNameError extends AppError {
  constructor(message: string) {
    super("DRIVE_NAME_INVALID", message);
    this.name = "DriveNameError";
  }
}

const SPACE = 0x20;
const DEL = 0x7f;

/** C0 range plus DEL, tested by code point so no control character appears in this source file. */
function hasControlChar(name: string): boolean {
  for (const char of name) {
    const code = char.codePointAt(0) ?? 0;
    if (code < SPACE || code === DEL) return true;
  }
  return false;
}

/**
 * Validates a user-supplied drive name and returns its canonical form (trimmed).
 *
 * The non-string guard is not redundant with the declared type: a name arriving in a JSON body has
 * only claimed to be a string, and `.trim()` on anything else leaves a TypeError here — which no
 * adapter recognizes as an expected failure, so it surfaces as an opaque 500 rather than the 400
 * this policy exists to give.
 */
export function validateDriveName(raw: string): string {
  if (typeof raw !== "string") throw new DriveNameError("Drive name must be a string.");
  const name = raw.trim();

  if (!name) throw new DriveNameError("Drive name cannot be empty.");
  if (name.length > MAX_DRIVE_NAME_LENGTH) {
    throw new DriveNameError(`Drive name cannot exceed ${MAX_DRIVE_NAME_LENGTH} characters.`);
  }
  if (hasControlChar(name)) throw new DriveNameError("Drive name cannot contain control characters.");
  if (name.includes("/") || name.includes("\\")) {
    throw new DriveNameError("Drive name cannot contain path separators.");
  }
  // "." and ".." would resolve to the downloads directory itself or its parent.
  if (name === "." || name === "..") throw new DriveNameError(`Invalid drive name: "${raw}"`);
  return name;
}
