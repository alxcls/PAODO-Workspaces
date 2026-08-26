// Single source of truth for the workspaces root directory; override with WORKSPACES_ROOT env var in production.
import path from "path";
export const WORKSPACES_ROOT = process.env.WORKSPACES_ROOT ?? path.resolve(process.cwd(), "data");

// The agent's home directory, held on the same durable storage as the workspace itself so that
// everything it installs there survives the container being recreated. Dot-prefixed like the other
// internal stores (.proxy-ca, .versioning) so it is never mistaken for a workspace directory.
export const HOMES_DIR_NAME = ".homes";

/** Durable `/home/dev` for one workspace. Relative form is what the volume-subpath mount needs. */
export const workspaceHomeSubpath = (workspaceId: string): string => `${HOMES_DIR_NAME}/${workspaceId}`;
export const workspaceHomeDir = (workspaceId: string): string =>
  path.join(WORKSPACES_ROOT, HOMES_DIR_NAME, workspaceId);

/** Receipt for a finished seed. A sibling of the home, so it sits outside the mount the agent sees. */
export const workspaceHomeSeededMarker = (workspaceId: string): string => `${workspaceHomeDir(workspaceId)}.seeded`;

/**
 * System packages this workspace installed, replayed into a rebuilt container. A sibling of the
 * home for the same reason as the marker: durable, but not writable by the agent it describes.
 */
export const workspaceAptRecipeFile = (workspaceId: string): string => `${workspaceHomeDir(workspaceId)}.apt.json`;
