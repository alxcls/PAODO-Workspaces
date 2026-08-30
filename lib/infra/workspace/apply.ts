// Restores one workspace from its archive: the inverse of archiveWorkspace. Rebuilds the durable
// home, apt recipe and versioning repo (checked out into the work-tree), keyed by the original id.
import { mkdtemp, rm, copyFile, mkdir, writeFile, readFile } from "fs/promises";
import os from "os";
import path from "path";
import { extractArchive, exists, removeTree } from "../archive/core";
import { createAuditLogger } from "../logger";
import { WORKSPACES_ROOT, workspaceHomeDir, workspaceAptRecipeFile, workspaceHomeSeededMarker } from "../paths";
import { GitClient, type IGitClient } from "../git/gitClient";
import { MANIFEST_MEMBER, type ArchiveManifest } from "../../archive/manifest";
import { APT_MEMBER, FILES_MEMBER, HOME_MEMBER, isWorkspaceManifest } from "../../workspace/archive";

const audit = createAuditLogger("restore");

export interface WorkspaceApplyOptions {
  /** Root holding workspace dirs, `.versioning/` and `.homes/`. Defaults to WORKSPACES_ROOT. */
  rootDir?: string;
  git?: IGitClient;
  /** Overwrite an existing workspace rather than refuse. */
  force?: boolean;
}

export interface WorkspaceApplied {
  id: string;
  name: string;
}

// Rebuilds the versioning git-dir from its bundle and checks HEAD out into the work-tree, mirroring
// how the app itself operates the repo (git-dir outside the tree, explicit --work-tree).
async function restoreVersioning(git: IGitClient, gitDir: string, workspaceDir: string, bundle: string): Promise<void> {
  await mkdir(gitDir, { recursive: true });
  const init = await git.run(["--git-dir", gitDir, "init"]);
  if (init.code !== 0) throw new Error(`git init failed: ${init.stderr || init.stdout}`);
  const fetch = await git.run(["--git-dir", gitDir, "fetch", bundle, "+refs/*:refs/*"]);
  if (fetch.code !== 0) throw new Error(`git fetch from bundle failed: ${fetch.stderr || fetch.stdout}`);
  const branch = await git.run(["--git-dir", gitDir, "for-each-ref", "--count=1", "--format=%(refname)", "refs/heads/"]);
  const ref = branch.stdout.trim();
  if (!ref) throw new Error("restored bundle has no branch to check out");
  const head = await git.run(["--git-dir", gitDir, "symbolic-ref", "HEAD", ref]);
  if (head.code !== 0) throw new Error(`git symbolic-ref failed: ${head.stderr || head.stdout}`);
  const reset = await git.run(["--git-dir", gitDir, "--work-tree", workspaceDir, "reset", "--hard"]);
  if (reset.code !== 0) throw new Error(`git reset --hard failed: ${reset.stderr || reset.stdout}`);
}

export async function applyWorkspaceArchive(
  archivePath: string,
  opts: WorkspaceApplyOptions = {},
): Promise<WorkspaceApplied> {
  const root = opts.rootDir ?? WORKSPACES_ROOT;
  const git = opts.git ?? new GitClient();
  let stageDir: string | undefined;
  try {
    stageDir = await mkdtemp(path.join(os.tmpdir(), "paodo-ws-restore-"));
    await extractArchive(archivePath, stageDir);

    const manifest = JSON.parse(await readFile(path.join(stageDir, MANIFEST_MEMBER), "utf-8")) as ArchiveManifest;
    if (!isWorkspaceManifest(manifest)) throw new Error(`${archivePath} is not a workspace archive`);
    const { id, name } = manifest.workspace;

    const workspaceDir = path.join(root, id);
    const homeDir = workspaceHomeDir(id, root);
    const gitDir = path.join(root, ".versioning", id);
    const aptFile = workspaceAptRecipeFile(id, root);

    if (!opts.force && ((await exists(workspaceDir)) || (await exists(homeDir)))) {
      throw new Error(`refusing to overwrite workspace ${id} without force`);
    }
    for (const target of [workspaceDir, homeDir, gitDir, aptFile]) await removeTree(target);
    await mkdir(workspaceDir, { recursive: true });
    await mkdir(homeDir, { recursive: true });

    if (await exists(path.join(stageDir, HOME_MEMBER))) await extractArchive(path.join(stageDir, HOME_MEMBER), homeDir);
    // The restored home is already seeded; the marker stops the container reseeding over it on boot.
    await writeFile(workspaceHomeSeededMarker(id, root), "");
    if (await exists(path.join(stageDir, APT_MEMBER))) await copyFile(path.join(stageDir, APT_MEMBER), aptFile);
    if (await exists(path.join(stageDir, FILES_MEMBER))) {
      await restoreVersioning(git, gitDir, workspaceDir, path.join(stageDir, FILES_MEMBER));
    }

    audit.info({ event: "workspace_restored", workspaceId: id, name }, "workspace restored");
    return { id, name };
  } finally {
    if (stageDir) await rm(stageDir, { recursive: true, force: true });
  }
}
