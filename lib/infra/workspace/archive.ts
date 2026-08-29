// Captures one workspace as a single portable tar. Free of docker and network concerns: the caller
// supplies image identity, so this module is filesystem plus git and nothing else.
import { mkdtemp, copyFile, rm, writeFile } from "fs/promises";
import os from "os";
import path from "path";
import {
  archiveSource,
  archiveStamp,
  describeMembers,
  exists,
  resolveDestination,
  run,
  slugify,
  writeArchive,
} from "../archive/core";
import { createAuditLogger, createLogger } from "../logger";
import { WORKSPACES_ROOT, workspaceHomeDir, workspaceAptRecipeFile } from "../paths";
import { GitClient, type IGitClient } from "../git/gitClient";
import { SCHEMA_VERSIONS, MANIFEST_MEMBER } from "../../archive/manifest";
import {
  APT_MEMBER,
  CONFIG_MEMBER,
  FILES_MEMBER,
  HOME_MEMBER,
  MEMBER_ORDER,
  type ArchiveImage,
  type WorkspaceArchiveManifest,
} from "../../workspace/archive";
import type { Workspace } from "../../workspace/types";

const log = createLogger("archive");
const audit = createAuditLogger("archive");

/** Stores that exist but are deliberately not captured, recorded in the manifest for restore. */
const UNBACKED_STORES = ["workspace-secrets", "mcp-tokens", "provider-keys"];

const ARCHIVE_SUFFIX = ".tar";

export interface ArchiveOptions {
  /** Root holding workspace dirs, `.versioning/` and `.homes/`. Overridable for tests. */
  rootDir?: string;
  image?: ArchiveImage;
  git?: IGitClient;
}

export interface ArchiveResult {
  path: string;
  bytes: number;
  manifest: WorkspaceArchiveManifest;
}

/**
 * Ordered so a plain alphabetical listing reads correctly: deployment, then the id a rename cannot
 * move, then the instant. The slug trails because it is the one field that changes over a
 * workspace's life — ahead of the timestamp it would sort a renamed history out of order.
 */
export function archiveFileName(workspace: Workspace, deployment: string, at: Date): string {
  const stem = `${slugify(deployment)}-${workspace.id}-${archiveStamp(at)}`;
  return `paodo-ws-${stem}-${slugify(workspace.name)}${ARCHIVE_SUFFIX}`;
}

/**
 * Bundles the workspace's snapshot history. A workspace whose versioning repo has no commits yet
 * yields no member rather than a failure — `git bundle` refuses to write an empty bundle.
 */
async function writeFilesBundle(git: IGitClient, gitDir: string, out: string): Promise<boolean> {
  if (!(await exists(gitDir))) return false;
  const refs = await git.run(["--git-dir", gitDir, "for-each-ref", "--count=1", "--format=%(refname)"]);
  if (refs.code !== 0 || !refs.stdout) return false;
  const bundle = await git.run(["--git-dir", gitDir, "bundle", "create", out, "--all"]);
  if (bundle.code !== 0) throw new Error(`git bundle failed: ${bundle.stderr || bundle.stdout}`);
  return true;
}

/**
 * Tars the durable home whole — every file, no exclusions, matching how the versioning repo
 * captures the workspace tree. Exit 1 is tar's "file changed as we read it" warning, expected on a
 * live home and not a reason to fail the backup.
 */
async function writeHomeArchive(homeDir: string, out: string): Promise<boolean> {
  if (!(await exists(homeDir))) return false;
  const result = await run("tar", ["-czf", out, "-C", homeDir, "."]);
  if (result.code > 1) throw new Error(`tar of home failed: ${result.stderr || result.stdout}`);
  if (result.code === 1) log.warn({ event: "archive_home_changed_during_read", homeDir }, result.stderr);
  return true;
}

function configOf(workspace: Workspace): WorkspaceArchiveManifest["config"] {
  return {
    llmProvider: workspace.llmProvider,
    llmModel: workspace.llmModel,
    reasoningEffort: workspace.reasoningEffort,
    maxIterations: workspace.maxIterations,
    maxRunMinutes: workspace.maxRunMinutes,
    internetAccess: workspace.internetAccess,
  };
}

/**
 * Writes a portable archive of one workspace: config, snapshot history, durable home and apt
 * recipe. Nothing inside carries an absolute host path or assumes the id is free on the target,
 * so the result restores onto a different tenant.
 */
export async function archiveWorkspace(
  workspace: Workspace,
  dest: string,
  opts: ArchiveOptions = {},
): Promise<ArchiveResult> {
  const root = opts.rootDir ?? WORKSPACES_ROOT;
  const git = opts.git ?? new GitClient();
  const capturedAt = new Date();
  const source = archiveSource(capturedAt);
  const target = await resolveDestination(dest, ARCHIVE_SUFFIX, () =>
    archiveFileName(workspace, source.deployment, capturedAt),
  );
  const stageDir = await mkdtemp(path.join(os.tmpdir(), "paodo-archive-"));

  try {
    const present: string[] = [CONFIG_MEMBER];
    await writeFile(path.join(stageDir, CONFIG_MEMBER), JSON.stringify(configOf(workspace), null, 2));

    const recipe = workspaceAptRecipeFile(workspace.id, root);
    if (await exists(recipe)) {
      await copyFile(recipe, path.join(stageDir, APT_MEMBER));
      present.push(APT_MEMBER);
    }

    const gitDir = path.join(root, ".versioning", workspace.id);
    if (await writeFilesBundle(git, gitDir, path.join(stageDir, FILES_MEMBER))) present.push(FILES_MEMBER);

    const homeDir = workspaceHomeDir(workspace.id, root);
    if (await writeHomeArchive(homeDir, path.join(stageDir, HOME_MEMBER))) present.push(HOME_MEMBER);

    const manifest: WorkspaceArchiveManifest = {
      schemaVersion: SCHEMA_VERSIONS.workspace,
      kind: "workspace",
      workspace: {
        id: workspace.id,
        name: workspace.name,
        description: workspace.description,
        createdAt: workspace.createdAt.toISOString(),
      },
      config: configOf(workspace),
      source,
      image: opts.image ?? { ref: process.env.CONTAINER_IMAGE ?? "paodo-workspace", hash: null },
      contents: await describeMembers(stageDir, present),
      omitted: { stores: UNBACKED_STORES },
    };
    await writeFile(path.join(stageDir, MANIFEST_MEMBER), JSON.stringify(manifest, null, 2));

    const ordered = MEMBER_ORDER.filter((name) => name === MANIFEST_MEMBER || present.includes(name));
    const bytes = await writeArchive(stageDir, [...ordered], target);

    audit.info(
      { event: "workspace_archived", workspaceId: workspace.id, path: target, bytes, members: ordered },
      "workspace archived",
    );
    return { path: target, bytes, manifest };
  } finally {
    await rm(stageDir, { recursive: true, force: true });
  }
}
