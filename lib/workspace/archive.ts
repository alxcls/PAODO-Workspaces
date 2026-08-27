import type { ReasoningEffort } from "../models/llmSelection";

/** Bumped whenever a member is added, removed, or changes meaning. Restore reads this first. */
export const ARCHIVE_SCHEMA_VERSION = 1;

export const MANIFEST_MEMBER = "manifest.json";
export const CONFIG_MEMBER = "config.json";
export const APT_MEMBER = "apt.json";
export const FILES_MEMBER = "files.bundle";
export const HOME_MEMBER = "home.tar.gz";

/**
 * Tar member order. The manifest leads so `tar xOf archive.tar manifest.json` answers "what is
 * this?" without decompressing gigabytes of home.
 */
export const MEMBER_ORDER = [MANIFEST_MEMBER, CONFIG_MEMBER, APT_MEMBER, FILES_MEMBER, HOME_MEMBER] as const;

export interface ArchiveMember {
  name: string;
  bytes: number;
  sha256: string;
}

/** The workspace image the home and apt recipe were captured against. */
export interface ArchiveImage {
  ref: string;
  hash: string | null;
}

export interface ArchiveManifest {
  schemaVersion: number;
  workspace: {
    /** The id on the source tenant. Recorded for provenance only — restore mints a fresh one. */
    id: string;
    name: string;
    description?: string;
    createdAt: string;
  };
  config: {
    llmProvider?: string;
    llmModel?: string;
    reasoningEffort?: ReasoningEffort;
    maxIterations: number;
    maxRunMinutes: number;
    internetAccess: boolean;
  };
  source: {
    host: string;
    capturedAt: string;
    paodoCommit: string | null;
  };
  image: ArchiveImage;
  contents: ArchiveMember[];
  /** What was deliberately left out, so a restore can explain the gaps rather than hide them. */
  omitted: {
    /** Present-but-unbacked stores, named so a cross-tenant rebuild knows what it must re-enter. */
    stores: string[];
  };
}
