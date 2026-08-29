import { MANIFEST_MEMBER, type ArchiveManifest } from "../archive/manifest";

export const GRAPH_MEMBER = "graph.json";

// Manifest first, so `tar xOf archive.tar manifest.json` says what a file is without unpacking it.
export const GRAPH_MEMBER_ORDER = [MANIFEST_MEMBER, GRAPH_MEMBER] as const;

export interface GraphArchiveManifest extends ArchiveManifest {
  kind: "graph";
}
