// Captures a whole deployment as one coherent set: graph + database + every workspace under
// <instance>/<stamp>-<id>/, with a parent backup.json that defines the set. Filesystem only —
// shipping the set to S3 is the caller's concern, so this stays testable without a network.
import path from "path";
import { randomBytes } from "crypto";
import { writeFile } from "fs/promises";
import { archiveGraph } from "../graph/archive";
import { archiveDatabase } from "../data/archive";
import { archiveWorkspace } from "../workspace/archive";
import { archiveSource, archiveStamp, sha256File, slugify } from "../archive/core";
import { hashDockerfile } from "../docker/dockerfileHasher";
import { getStore } from "../services";
import { SCHEMA_VERSIONS, type ArchiveManifest } from "../../archive/manifest";
import { isWorkspaceManifest, type ArchiveImage } from "../../workspace/archive";
import { SET_MANIFEST_MEMBER, type BackupSet, type SetEntry } from "../../archive/setManifest";
import type { Workspace } from "../../workspace/types";

interface Archived {
  path: string;
  bytes: number;
  manifest: ArchiveManifest;
}

export interface SetArchiveOptions {
  /** Defaults to every workspace in the store; injectable so a test can pass its own. */
  workspaces?: Workspace[];
  /** Defaults to the deployed image; injectable so a test need not hash a Dockerfile. */
  image?: ArchiveImage;
  /** Root holding workspace dirs, passed through to the workspace archive. */
  rootDir?: string;
}

export interface SetArchiveResult {
  manifest: BackupSet;
  setDir: string;
  prefix: string;
  archives: Archived[];
}

async function setEntryOf(archived: Archived): Promise<SetEntry> {
  const { manifest } = archived;
  const file = path.basename(archived.path);
  const bytes = archived.bytes;
  const sha256 = await sha256File(archived.path);
  if (manifest.kind === "workspace") {
    if (!isWorkspaceManifest(manifest)) throw new Error("workspace archive missing workspace manifest");
    return { kind: "workspace", file, bytes, sha256, workspaceId: manifest.workspace.id };
  }
  return { kind: manifest.kind, file, bytes, sha256 };
}

/** Writes a full set into `dest`. Returns the set manifest, its directory and the archives it holds. */
export async function archiveSet(dest: string, opts: SetArchiveOptions = {}): Promise<SetArchiveResult> {
  const source = archiveSource(new Date());
  const id = randomBytes(6).toString("hex");
  const instance = slugify(source.deployment);
  const stamp = archiveStamp(new Date(source.capturedAt));
  const prefix = `${instance}/${stamp}-${id}`;
  const setDir = path.join(dest, prefix);

  const image =
    opts.image ?? { ref: process.env.CONTAINER_IMAGE ?? "paodo-workspace", hash: await hashDockerfile("Dockerfile.workspace") };
  const workspaces = opts.workspaces ?? getStore().listWorkspaces();

  const archives: Archived[] = [await archiveGraph(setDir), await archiveDatabase(setDir)];
  for (const workspace of workspaces) {
    archives.push(await archiveWorkspace(workspace, setDir, { image, rootDir: opts.rootDir }));
  }

  const manifest: BackupSet = {
    schemaVersion: SCHEMA_VERSIONS.set,
    kind: "set",
    id,
    instance,
    source,
    entries: await Promise.all(archives.map(setEntryOf)),
  };
  await writeFile(path.join(setDir, SET_MANIFEST_MEMBER), JSON.stringify(manifest, null, 2));

  return { manifest, setDir, prefix, archives };
}
