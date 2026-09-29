// Single source of truth for the workspaces root directory; override with WORKSPACES_ROOT env var in production.
import path from "path";
export const WORKSPACES_ROOT = process.env.WORKSPACES_ROOT ?? path.resolve(process.cwd(), "data");

// The agent's home directory, held on the same durable storage as the workspace itself so that
// everything it installs there survives the container being recreated. Dot-prefixed like the other
// internal stores (.proxy-ca, .versioning) so it is never mistaken for a workspace directory.
export const HOMES_DIR_NAME = ".homes";

/** The workspace registry, captured in the database archive beside the rows it indexes. */
export const workspaceRegistryFile = (root: string = WORKSPACES_ROOT): string => path.join(root, ".workspaces.json");

/** The deployment-wide agent connection graph, read at startup and rewritten on every edit. */
export const workspaceGraphFile = (root: string = WORKSPACES_ROOT): string => path.join(root, ".workspace-graph.json");

/** The shared-drive registry and its workspace connections, siblings of the workspace registry. */
export const drivesRegistryFile = (root: string = WORKSPACES_ROOT): string => path.join(root, ".drives.json");
export const driveConnectionsFile = (root: string = WORKSPACES_ROOT): string =>
  path.join(root, ".drive-connections.json");

/** Root holding every drive's content, one `<driveId>/` subdir each. Never mounted into a container. */
export const drivesContentDir = (root: string = WORKSPACES_ROOT): string => path.join(root, ".drives");

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

/** A workspace's work-tree directory, keyed by its immutable id. */
export const workspaceDir = (workspaceId: string, root: string = WORKSPACES_ROOT): string =>
  path.join(root, workspaceId);

/** The workspace's versioning git-dir, held outside the work-tree so the agent never sees it. */
export const workspaceVersioningDir = (workspaceId: string, root: string = WORKSPACES_ROOT): string =>
  path.join(root, ".versioning", workspaceId);

/** Every on-disk artifact a workspace owns — the footprint restore rebuilds and a prune removes. */
export const workspaceArtifactPaths = (workspaceId: string, root: string = WORKSPACES_ROOT): string[] => [
  workspaceDir(workspaceId, root),
  workspaceHomeDir(workspaceId, root),
  workspaceVersioningDir(workspaceId, root),
  workspaceAptRecipeFile(workspaceId, root),
  workspaceHomeSeededMarker(workspaceId, root),
];
