// The parent manifest that turns a pile of archives into one restorable set. Pure types and the
// restore order: no filesystem or tar, so a future restore reads this without pulling infra in.
import type { ArchiveKind, TarMember, ArchiveSource } from "./manifest";

export const SET_MANIFEST_MEMBER = "backup.json";
export const SET_SCHEMA_VERSION = 1;

// Agents must exist before the rows keyed to them and the edges that reference them, so restore
// applies members in this order regardless of how they sit in the manifest.
export const RESTORE_ORDER: readonly ArchiveKind[] = ["workspace", "database", "graph"];

export interface SetMember extends TarMember {
  kind: ArchiveKind;
  /** Present only for workspace members, so a set names which agents it holds. */
  workspaceId?: string;
}

export interface BackupSetManifest {
  schemaVersion: number;
  kind: "set";
  /** `<stamp>-<random>`: sorts by time for rotation, the suffix keeps same-second runs distinct. */
  id: string;
  source: ArchiveSource;
  members: SetMember[];
}
