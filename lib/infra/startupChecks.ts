// Pure/testable production-startup preflights. These run before the server begins accepting
// requests, so a broken data mount or registry cannot be mistaken for a healthy empty install.
import fs from "fs";
import path from "path";
import { randomUUID } from "crypto";
import { workspaceRegistryFile } from "./paths";

/**
 * The app orchestrates workspaces through volume-subpath mounts, which only resolve when its own
 * state lives on that named volume. Running without one used to be a supported host mode; it no
 * longer is, so an unset name is a misconfiguration to fail on rather than a second code path.
 */
export function assertWorkspacesVolumeConfigured(volume: string | null): asserts volume is string {
  if (!volume) throw new Error("WORKSPACES_VOLUME_NAME is unset — the app runs only against the workspaces volume");
}

export function assertDataRootAvailable(root: string): void {
  fs.mkdirSync(root, { recursive: true });
  if (!fs.statSync(root).isDirectory()) throw new Error(`workspace data root is not a directory: ${root}`);

  // Exercise the same primitives used by the stores: write + read + atomic rename. access(W_OK)
  // alone is not enough on unusual mounts and can report success before an actual write fails.
  const probe = path.join(root, `.startup-probe-${process.pid}-${randomUUID()}`);
  const renamed = `${probe}.renamed`;
  let failure: unknown = null;
  try {
    fs.writeFileSync(probe, "ok", { flag: "wx", mode: 0o600 });
    if (fs.readFileSync(probe, "utf8") !== "ok") throw new Error("workspace data-root probe read mismatch");
    fs.renameSync(probe, renamed);
  } catch (err) {
    failure = err;
  }
  for (const candidate of [probe, renamed]) {
    try {
      fs.rmSync(candidate, { force: true });
    } catch (err) {
      failure ??= err;
    }
  }
  if (failure) throw failure;
}

export function assertWorkspaceRegistryRecords(value: unknown): asserts value is Array<Record<string, unknown>> {
  if (!Array.isArray(value)) throw new Error("workspace registry must contain a JSON array");
  for (const [index, item] of value.entries()) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error(`workspace registry entry ${index} must be an object`);
    }
    const record = item as Record<string, unknown>;
    if (typeof record.id !== "string" || !record.id) {
      throw new Error(`workspace registry entry ${index} has no valid id`);
    }
    if (typeof record.name !== "string" || !record.name) {
      throw new Error(`workspace registry entry ${index} has no valid name`);
    }
    if (typeof record.createdAt !== "string" || !Number.isFinite(Date.parse(record.createdAt))) {
      throw new Error(`workspace registry entry ${index} has no valid createdAt timestamp`);
    }
  }
}

/** Missing is the valid first-run state; an existing unreadable or malformed registry is not. */
export function assertWorkspaceRegistryAvailable(root: string): void {
  const file = workspaceRegistryFile(root);
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }
  assertWorkspaceRegistryRecords(JSON.parse(raw) as unknown);
}
