// Deterministic Docker resource names, keyed by workspace id. Shared by the container-lifecycle
// manager and its collaborators (background tasks, proxy networking) so the `ws_`/`wsnet_` prefixes
// live in exactly one place.
export const containerName = (workspaceId: string): string => `ws_${workspaceId}`;
export const networkName = (workspaceId: string): string => `wsnet_${workspaceId}`;
