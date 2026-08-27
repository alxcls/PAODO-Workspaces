// Single source of truth for the workspaces root directory; override with WORKSPACES_ROOT env var in production.
import path from "path";
export const WORKSPACES_ROOT = process.env.WORKSPACES_ROOT ?? path.resolve(process.cwd(), "data");

// The agent's home directory, held on the same durable storage as the workspace itself so that
// everything it installs there survives the container being recreated. Dot-prefixed like the other
// internal stores (.proxy-ca, .versioning) so it is never mistaken for a workspace directory.
export const HOMES_DIR_NAME = ".homes";

/** Durable `/home/dev` for one workspace. Relative form is what the volume-subpath mount needs. */
export const workspaceHomeSubpath = (workspaceId: string): string => `${HOMES_DIR_NAME}/${workspaceId}`;

// `root` defaults to the live WORKSPACES_ROOT; tooling that reads a root other than this process's
// (archiving, tests) passes it explicitly rather than rewriting the returned path.
export const workspaceHomeDir = (workspaceId: string, root: string = WORKSPACES_ROOT): string =>
  path.join(root, HOMES_DIR_NAME, workspaceId);

/** Receipt for a finished seed. A sibling of the home, so it sits outside the mount the agent sees. */
export const workspaceHomeSeededMarker = (workspaceId: string, root: string = WORKSPACES_ROOT): string =>
  `${workspaceHomeDir(workspaceId, root)}.seeded`;

/**
 * System packages this workspace installed, replayed into a rebuilt container. A sibling of the
 * home for the same reason as the marker: durable, but not writable by the agent it describes.
 */
export const workspaceAptRecipeFile = (workspaceId: string, root: string = WORKSPACES_ROOT): string =>
  `${workspaceHomeDir(workspaceId, root)}.apt.json`;
