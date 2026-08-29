// Captures the deployment-wide agent graph as one verifiable archive. The whole file, not a slice:
// the graph is a single cross-workspace document, restored after the workspaces its edges reference.
import { mkdtemp, rm, writeFile } from "fs/promises";
import os from "os";
import path from "path";
import {
  archiveSource,
  archiveStamp,
  describeMembers,
  resolveDestination,
  slugify,
  writeArchive,
} from "../archive/core";
import { createAuditLogger } from "../logger";
import { SCHEMA_VERSIONS, MANIFEST_MEMBER } from "../../archive/manifest";
import { GRAPH_MEMBER, GRAPH_MEMBER_ORDER, type GraphArchiveManifest } from "../../graph/archive";
import { getGraph } from "../../agent/graph";

const audit = createAuditLogger("archive");

const ARCHIVE_SUFFIX = ".tar";

export interface GraphArchiveResult {
  path: string;
  bytes: number;
  manifest: GraphArchiveManifest;
}

export function graphArchiveFileName(deployment: string, at: Date): string {
  return `paodo-graph-${slugify(deployment)}-${archiveStamp(at)}${ARCHIVE_SUFFIX}`;
}

/** Writes an uncompressed archive of the whole workspace graph. gzip buys nothing on a file this size. */
export async function archiveGraph(dest: string): Promise<GraphArchiveResult> {
  const capturedAt = new Date();
  const source = archiveSource(capturedAt);
  const target = await resolveDestination(dest, ARCHIVE_SUFFIX, () =>
    graphArchiveFileName(source.deployment, capturedAt),
  );
  const stageDir = await mkdtemp(path.join(os.tmpdir(), "paodo-graph-archive-"));

  try {
    const graph = getGraph();
    await writeFile(path.join(stageDir, GRAPH_MEMBER), JSON.stringify(graph, null, 2));

    const manifest: GraphArchiveManifest = {
      schemaVersion: SCHEMA_VERSIONS.graph,
      kind: "graph",
      source,
      contents: await describeMembers(stageDir, [GRAPH_MEMBER]),
    };
    await writeFile(path.join(stageDir, MANIFEST_MEMBER), JSON.stringify(manifest, null, 2));

    const bytes = await writeArchive(stageDir, [...GRAPH_MEMBER_ORDER], target);

    audit.info(
      {
        event: "graph_archived",
        deployment: source.deployment,
        path: target,
        bytes,
        edges: graph.edges.length,
        nodes: Object.keys(graph.positions).length,
        members: [...GRAPH_MEMBER_ORDER],
      },
      "graph archived",
    );
    return { path: target, bytes, manifest };
  } finally {
    await rm(stageDir, { recursive: true, force: true });
  }
}
