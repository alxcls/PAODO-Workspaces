// Drive metadata use cases, shared by every trigger.
//
// The rule these own is that a drive named in a request has to exist for the request to mean
// anything — and that saying so is the operation's job, not each route's. The store answers a missing
// drive with `undefined` from update and `false` from delete, which is the right shape for a registry
// and the wrong one for a caller: a delete that reports `{ deleted: false }` with a 200 is a failure
// wearing a success's clothes, and the UI and the CLI were each left to decide what to make of it.
//
// Deps are injected the same way lib/operations/drives/connect.ts injects them, so these are testable
// without touching disk and the store's own names never collide with the ones exported here.
import { AppError, requireNonEmptyString } from "@/lib/errors/appError";
import * as store from "@/lib/drives/store";
import type { Drive } from "@/lib/drives/store";

export interface CreateDriveInput {
  name?: unknown;
  description?: unknown;
}

export interface UpdateDriveInput {
  name?: unknown;
  description?: unknown;
}

export interface DeleteDriveResult {
  deleted: true;
}

/** Narrower than the drive store: the five metadata calls and nothing else. */
export interface DriveDeps {
  list(): Drive[];
  get(driveId: string): Drive | undefined;
  create(name: string, description?: string): Drive;
  update(driveId: string, patch: { name?: string; description?: string }): Drive | undefined;
  remove(driveId: string): Promise<boolean>;
}

function defaultDeps(): DriveDeps {
  return {
    list: store.listDrives,
    get: store.getDrive,
    create: store.createDrive,
    update: store.updateDrive,
    remove: store.deleteDrive,
  };
}

function notFound(): AppError {
  return new AppError("NOT_FOUND", "drive not found", { field: "driveId" });
}

/** An optional string field: absent means unchanged, and a non-string is the caller's to fix. */
function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new AppError("INVALID_REQUEST", `${field} must be a string`, { field });
  }
  return value;
}

export function listDrives(deps: DriveDeps = defaultDeps()): Drive[] {
  return deps.list();
}

export function getDrive(driveIdValue: unknown, deps: DriveDeps = defaultDeps()): Drive {
  const driveId = requireNonEmptyString(driveIdValue, "driveId");
  const drive = deps.get(driveId);
  if (!drive) throw notFound();
  return drive;
}

/**
 * The name is validated by lib/drives/name.ts inside the store call, so a rejection carries
 * DRIVE_NAME_INVALID and its own message rather than a generic one composed here.
 */
export function createDrive(input: CreateDriveInput, deps: DriveDeps = defaultDeps()): Drive {
  const name = requireNonEmptyString(input.name, "name");
  return deps.create(name, optionalString(input.description, "description"));
}

export const UPDATABLE_FIELDS = ["name", "description"] as const;

/**
 * Omitted means unchanged; an explicitly empty description clears it, as the store already does.
 *
 * An unrecognised field is refused rather than dropped, the same way a workspace PATCH refuses one:
 * a misspelling alongside a valid field would otherwise apply half the request and answer `ok` with
 * the typo nowhere in the reply — a partial change reported as a complete one, which no caller can
 * detect. `paodo drive set <id> nmae=x` reported success and changed nothing. The refusal names the
 * accepted fields, because a programmatic caller has no form to discover them from.
 */
export function updateDrive(driveIdValue: unknown, input: UpdateDriveInput, deps: DriveDeps = defaultDeps()): Drive {
  const driveId = requireNonEmptyString(driveIdValue, "driveId");
  const fields = UPDATABLE_FIELDS as readonly string[];
  const unknown = Object.keys(input).filter((key) => !fields.includes(key));
  if (unknown.length > 0) {
    throw new AppError("INVALID_REQUEST", `unknown field(s): ${unknown.join(", ")} — accepted: ${fields.join(", ")}`, {
      fields: unknown,
      acceptedFields: [...UPDATABLE_FIELDS],
    });
  }
  if (fields.every((field) => input[field as keyof UpdateDriveInput] === undefined)) {
    throw new AppError("INVALID_REQUEST", `no fields supplied — send at least one of: ${fields.join(", ")}`, {
      acceptedFields: [...UPDATABLE_FIELDS],
    });
  }
  const patch = {
    ...(input.name === undefined ? {} : { name: requireNonEmptyString(input.name, "name") }),
    ...(input.description === undefined ? {} : { description: optionalString(input.description, "description")! }),
  };
  const drive = deps.update(driveId, patch);
  if (!drive) throw notFound();
  return drive;
}

/**
 * Removes the drive, its connections, and its files. Raises NOT_FOUND rather than reporting
 * `deleted: false`, so a receipt that says it succeeded always names something that was really there —
 * the same answer DELETE on a workspace gives.
 */
export async function deleteDrive(driveIdValue: unknown, deps: DriveDeps = defaultDeps()): Promise<DeleteDriveResult> {
  const driveId = requireNonEmptyString(driveIdValue, "driveId");
  if (!(await deps.remove(driveId))) throw notFound();
  return { deleted: true };
}
