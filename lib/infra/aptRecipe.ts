// The list of system packages a workspace has installed, so a rebuilt container can get them back.
//
// Everything else the agent installs — nvm, pyenv, npm, pip — lands in $HOME and rides the durable
// /home/dev mount. apt is the exception: it writes to /usr, /etc and /var, which nothing mounts.
//
// Kept as the instruction, not the artifacts. Restoring files without dpkg's database, dependency
// closure and postinst scripts gives a broken half-install, and a captured filesystem diff would
// also pin every rebuilt workspace to the package versions current when it was first set up —
// re-running apt-get against a newer base image installs the newer package instead.
//
// AptInstallTool is the only path to a system package (uid 1000, no setuid sudo, no-new-privileges),
// so recording at that one call site is exact by construction, with nothing to diff or reconcile.
import { workspaceAptRecipeFile } from "./paths";
import { atomicSaveJson, readJson } from "./jsonPersist";
import { createLogger } from "./logger";

const log = createLogger("aptRecipe");

/** Package specs as passed to apt-get: a bare name, or name=version. */
export type AptRecipe = string[];

export function readAptRecipe(workspaceId: string): AptRecipe {
  const recipe = readJson<AptRecipe>(workspaceAptRecipeFile(workspaceId), []);
  return Array.isArray(recipe) ? recipe.filter((p) => typeof p === "string") : [];
}

/**
 * Adds packages to the workspace's recipe. Called only after apt-get reports success, so the recipe
 * never accumulates a package that failed to install and would fail again on every future rebuild.
 *
 * Deduplicated on the package NAME, so re-installing something at a new pin supersedes the old spec
 * rather than queueing two conflicting ones. A Map keeps each package at its first position while
 * still taking the latest spec, so the replay order stays stable as the recipe grows.
 */
export function recordAptPackages(workspaceId: string, packages: string[]): void {
  const byName = new Map<string, string>();
  for (const spec of [...readAptRecipe(workspaceId), ...packages]) {
    byName.set(spec.split("=")[0], spec);
  }
  const recipe = [...byName.values()];
  try {
    atomicSaveJson(workspaceAptRecipeFile(workspaceId), recipe);
  } catch (err) {
    // The packages ARE installed and usable — only their replay-after-rebuild record is missing.
    log.error(
      { event: "apt_recipe_save_failed", outcome: "packages_not_recorded_for_rebuild", err, workspaceId, packages },
      "failed to record apt packages — they will not be reinstalled if the container is rebuilt",
    );
  }
}
