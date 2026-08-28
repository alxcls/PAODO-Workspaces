import type { ReasoningEffort } from "../models/llmSelection";
import { MANIFEST_MEMBER, type ArchiveManifest } from "../archive/manifest";

export const CONFIG_MEMBER = "config.json";
export const APT_MEMBER = "apt.json";
export const FILES_MEMBER = "files.bundle";
export const HOME_MEMBER = "home.tar.gz";

/**
 * Tar member order. The manifest leads so `tar xOf archive.tar manifest.json` answers "what is
 * this?" without decompressing gigabytes of home.
 */
export const MEMBER_ORDER = [MANIFEST_MEMBER, CONFIG_MEMBER, APT_MEMBER, FILES_MEMBER, HOME_MEMBER] as const;

/** The workspace image the home and apt recipe were captured against. */
export interface ArchiveImage {
  ref: string;
  hash: string | null;
}

export interface WorkspaceArchiveManifest extends ArchiveManifest {
  kind: "workspace";
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
  image: ArchiveImage;
  /** What was deliberately left out, so a restore can explain the gaps rather than hide them. */
  omitted: {
    /** Present-but-unbacked stores, named so a cross-tenant rebuild knows what it must re-enter. */
    stores: string[];
  };
}

/** Narrows a manifest read back off disk, so verify and restore can name the workspace it holds. */
export function isWorkspaceManifest(manifest: ArchiveManifest): manifest is WorkspaceArchiveManifest {
  return manifest.kind === "workspace";
}
