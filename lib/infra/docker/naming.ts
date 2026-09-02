// Deterministic Docker resource names, keyed by workspace id. Shared by the container-lifecycle
// manager and its collaborators (background tasks, proxy networking) so the `ws_`/`wsnet_` prefixes
// live in exactly one place.
export const CONTAINER_PREFIX = "ws_";
export const NETWORK_PREFIX = "wsnet_";
export const containerName = (workspaceId: string): string => `${CONTAINER_PREFIX}${workspaceId}`;
export const networkName = (workspaceId: string): string => `${NETWORK_PREFIX}${workspaceId}`;
// Inverses of the name builders: recover the workspace id from a discovered resource name (e.g. from
// `docker ps`/`docker network ls`), or null if it isn't one of ours. Keep callers off the literals.
export const workspaceIdFromContainerName = (name: string): string | null =>
  name.startsWith(CONTAINER_PREFIX) ? name.slice(CONTAINER_PREFIX.length) : null;
export const workspaceIdFromNetworkName = (name: string): string | null =>
  name.startsWith(NETWORK_PREFIX) ? name.slice(NETWORK_PREFIX.length) : null;
