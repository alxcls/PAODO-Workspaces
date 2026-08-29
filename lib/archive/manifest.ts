// Shape shared by every backup archive, whatever it holds. Pure types and names: no filesystem, no
// tar, no database — so both the writers and any future restore can read this without pulling infra in.

export const MANIFEST_MEMBER = "manifest.json";

/** What the archive holds. Restore dispatches on this rather than guessing from the filename. */
export type ArchiveKind = "workspace" | "database" | "graph";

/**
 * Per kind, because the formats change independently: bumping one for a member it gained must
 * not relabel another as a format this build has never seen. Restore reads this first.
 */
export const ARCHIVE_SCHEMA_VERSIONS: Record<ArchiveKind, number> = {
  workspace: 1,
  database: 1,
  graph: 1,
};

/** One file packed inside an archive tar, with its size and hash. Not a whole archive — see SetEntry. */
export interface TarMember {
  name: string;
  bytes: number;
  sha256: string;
}

/**
 * Where a backup came from. `deployment` is the name we chose (cobalt-lynx), not one the
 * infrastructure handed out: os.hostname() inside a container is a container id that changes on
 * every deploy, and the machine itself is what the disaster replaces. `host` is kept for diagnosis
 * only — never sort or trust by it.
 */
export interface ArchiveSource {
  deployment: string;
  host: string;
  capturedAt: string;
  paodoCommit: string | null;
}

export interface ArchiveManifest {
  schemaVersion: number;
  kind: ArchiveKind;
  source: ArchiveSource;
  contents: TarMember[];
}
