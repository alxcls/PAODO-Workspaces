import { MANIFEST_MEMBER, type ArchiveManifest } from "../archive/manifest";

export const DATABASE_MEMBER = "paodo.db";
export const REGISTRY_MEMBER = "workspaces.json";

/**
 * The registry travels with the database rather than on its own: every table is keyed by workspace
 * id, so without the list of workspaces those rows have nothing to attach to. Manifest first, so
 * `tar xOf archive.tar.gz manifest.json` says what a file is without unpacking it.
 */
export const DATABASE_MEMBER_ORDER = [MANIFEST_MEMBER, DATABASE_MEMBER, REGISTRY_MEMBER] as const;

export interface DatabaseArchiveManifest extends ArchiveManifest {
  kind: "database";
  database: {
    /** SQLite's user_version, so a restore can refuse a database written by newer code. */
    userVersion: number;
  };
}
