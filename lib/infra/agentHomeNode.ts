// Brings a durable agent home seeded by an older workspace image onto the image's current Node.
// Pure filesystem decisions; ContainerManager performs the one step that needs the image (the copy).
import { access, mkdir, readFile, readdir, rename, writeFile } from "fs/promises";
import path from "path";

// Defaults the image set before homes recorded a `.node` marker: `nvm alias default 22` (2026-08-25),
// then the exact pin (2026-08-26). Durable homes did not exist before that.
const LEGACY_IMAGE_DEFAULTS = ["22", "22.23.2"];
// nvm installs these with every Node version; any other global package was added by the agent.
const BUNDLED_GLOBALS = new Set(["npm", "corepack"]);

export type NodeUpgradePlan =
  | { action: "none" }
  | { action: "skip"; reason: "not_seeded" | "no_nvm" }
  | {
      action: "deliver";
      copy: boolean;
      previous: string | null;
      default: "move" | "current" | "custom" | "global_packages";
      globals: string[];
    };

export interface AgentHomePaths {
  homeDir: string;
  seededMarker: string;
  nodeMarker: string;
}

const exists = (p: string) =>
  access(p).then(
    () => true,
    () => false,
  );

async function readTrimmed(p: string): Promise<string | null> {
  try {
    return (await readFile(p, "utf-8")).trim();
  } catch {
    return null;
  }
}

/** The exact Node version Dockerfile.workspace installs, or null when it can't be read. */
export async function imageNodeVersion(dockerfilePath: string): Promise<string | null> {
  const content = await readTrimmed(dockerfilePath);
  return content?.match(/^ARG NODE_VERSION=(\d+\.\d+\.\d+)$/m)?.[1] ?? null;
}

const nodeVersionsDir = (homeDir: string) => path.join(homeDir, ".nvm", "versions", "node");
export const nodeVersionDir = (homeDir: string, version: string) => path.join(nodeVersionsDir(homeDir), `v${version}`);

const byVersion = (a: string, b: string) => {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  return pa[0] - pb[0] || pa[1] - pb[1] || pa[2] - pb[2];
};

/** The installed version an nvm alias resolves to, the way nvm does for exact and major-only aliases. */
function resolveAlias(alias: string, installed: string[]): string | null {
  const wanted = alias.replace(/^v/, "");
  if (/^\d+\.\d+\.\d+$/.test(wanted)) return installed.includes(wanted) ? wanted : null;
  if (!/^\d+$/.test(wanted)) return null;
  return (
    installed
      .filter((v) => v.split(".")[0] === wanted)
      .sort(byVersion)
      .pop() ?? null
  );
}

async function agentGlobals(homeDir: string, version: string): Promise<string[]> {
  const modules = path.join(nodeVersionDir(homeDir, version), "lib", "node_modules");
  const entries = await readdir(modules).catch(() => [] as string[]);
  const names: string[] = [];
  for (const entry of entries.filter((e) => !e.startsWith("."))) {
    if (!entry.startsWith("@")) names.push(entry);
    else
      for (const scoped of await readdir(path.join(modules, entry)).catch(() => [] as string[]))
        names.push(`${entry}/${scoped}`);
  }
  return names.filter((n) => !BUNDLED_GLOBALS.has(n)).sort();
}

/**
 * Decide what bringing this home onto `target` involves. The default only moves while it still names
 * what the image itself chose, and while that Node carries no global packages the agent installed.
 */
export async function planNodeUpgrade(paths: AgentHomePaths, target: string): Promise<NodeUpgradePlan> {
  const marker = await readTrimmed(paths.nodeMarker);
  if (marker === target) return { action: "none" };
  if (!(await exists(paths.seededMarker))) return { action: "skip", reason: "not_seeded" };
  if (!(await exists(path.join(paths.homeDir, ".nvm", "nvm.sh")))) return { action: "skip", reason: "no_nvm" };

  const installed = (await readdir(nodeVersionsDir(paths.homeDir)).catch(() => [] as string[]))
    .filter((d) => /^v\d+\.\d+\.\d+$/.test(d))
    .map((d) => d.slice(1));
  const copy = !(await exists(path.join(nodeVersionDir(paths.homeDir, target), "bin", "node")));
  const alias = await readTrimmed(path.join(paths.homeDir, ".nvm", "alias", "default"));
  const imageDefaults = marker ? [marker] : LEGACY_IMAGE_DEFAULTS;
  const previous = alias ? resolveAlias(alias, installed) : null;

  if (previous === target) return { action: "deliver", copy, previous, default: "current", globals: [] };
  if (alias && !imageDefaults.includes(alias.replace(/^v/, ""))) {
    return { action: "deliver", copy, previous, default: "custom", globals: [] };
  }
  const globals = previous ? await agentGlobals(paths.homeDir, previous) : [];
  return { action: "deliver", copy, previous, default: globals.length ? "global_packages" : "move", globals };
}

/** Point nvm's default at `version`, atomically so a concurrent shell never reads a half-written alias. */
export async function setDefaultAlias(homeDir: string, version: string): Promise<void> {
  const alias = path.join(homeDir, ".nvm", "alias", "default");
  await mkdir(path.dirname(alias), { recursive: true });
  await writeFile(`${alias}.tmp`, `${version}\n`);
  await rename(`${alias}.tmp`, alias);
}
