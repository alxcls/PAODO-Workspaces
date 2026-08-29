// The parent manifest that turns a pile of archives into one restorable set. Pure types: no
// filesystem or tar, so a future restore reads this without pulling infra in.
import type { ArchiveSource } from "./manifest";

export const SET_MANIFEST_MEMBER = "backup.json";

// One archive file in a set. `file` only locates it; the entry's identity is its kind — plus the
// workspaceId for a workspace, since those are the only members a deployment holds more than one of.
export type SetEntry =
  | { kind: "graph"; file: string; bytes: number; sha256: string }
  | { kind: "database"; file: string; bytes: number; sha256: string }
  | { kind: "workspace"; file: string; bytes: number; sha256: string; workspaceId: string };

export interface BackupSet {
  schemaVersion: number;
  kind: "set";
  /** Opaque unique token for this run. The capture time lives once, in source.capturedAt. */
  id: string;
  /** The path segment this set is stored under (source.deployment, slugified). With the stamp of
   *  source.capturedAt and id it reconstructs the object key: `<instance>/<stamp>-<id>/`. */
  instance: string;
  source: ArchiveSource;
  entries: SetEntry[];
}
