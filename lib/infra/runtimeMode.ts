/**
 * The one axis that still separates a dev run from a deployment: whether Next compiles on demand.
 *
 * There is no host mode. `npm run dev` runs the deployed topology — same containers, same volumes,
 * same sidecar — so the app is always containerized and always backed by the workspaces volume;
 * server.ts refuses to start without one. Only the source of the code differs, bind-mounted here
 * and prebuilt there, which is what NODE_ENV selects.
 *
 * Imports nothing on purpose. This module is pulled into the webpack bundle through
 * instrumentation.node.ts and into the esbuild bundle through proxyEntry.ts, and both reject
 * constructs the other accepts — a dependency-free module cannot break either one.
 */
export interface RuntimeMode {
  /** Next compiles routes on demand (HMR), rather than serving a prebuilt .next. */
  readonly hotReload: boolean;
  /** Docker volume holding workspace data. Null only where nothing mounts it: tests, and the sidecar. */
  readonly workspacesVolume: string | null;
  /** Served as a hardened browser origin: Secure session cookie. */
  readonly hardenedBrowser: boolean;
}

type RuntimeEnvironment = Record<string, string | undefined>;

/**
 * hardenedBrowser tracks hotReload today, and is named apart from it deliberately: each call site
 * says which property it actually depends on, so one can change later without dragging the other.
 */
export function readRuntimeMode(env: RuntimeEnvironment = process.env): RuntimeMode {
  const hotReload = env.NODE_ENV !== "production";
  return {
    hotReload,
    workspacesVolume: env.WORKSPACES_VOLUME_NAME?.trim() || null,
    hardenedBrowser: !hotReload,
  };
}

export const runtimeMode = readRuntimeMode();
