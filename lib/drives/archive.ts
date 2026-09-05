import { MANIFEST_MEMBER, type ArchiveManifest } from "../archive/manifest";

export const DRIVES_MEMBER = "drives.json";
export const CONNECTIONS_MEMBER = "drive-connections.json";
export const CONTENT_MEMBER = "drives-content.tar.gz";

// Manifest first, so `tar xOf archive.tar.gz manifest.json` says what an archive is without unpacking it.
export const DRIVES_MEMBER_ORDER = [MANIFEST_MEMBER, DRIVES_MEMBER, CONNECTIONS_MEMBER, CONTENT_MEMBER] as const;

export interface DrivesArchiveManifest extends ArchiveManifest {
  kind: "drives";
}
