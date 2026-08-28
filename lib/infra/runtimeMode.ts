/**
 * The two independent axes that separate a host dev loop from a deployed stack.
 *
 * NODE_ENV and WORKSPACES_VOLUME_NAME are not the same question and never move together:
 * compose sets both, `tsx server.ts` sets neither, and each one alone is a reachable state.
 * Reading them through one module keeps every call site honest about which it depends on.
 *
 * Imports nothing on purpose. This module is pulled into the webpack bundle through
 * instrumentation.node.ts and into the esbuild bundle through proxyEntry.ts, and both reject
 * constructs the other accepts — a dependency-free module cannot break either one.
 */
export interface RuntimeMode {
  /** Next compiles routes on demand (HMR). The host dev loop; false when serving a prebuilt .next. */
  readonly hotReload: boolean;
  /** Docker volume holding workspace data, or null when the app runs on the host against ./data. */
  readonly workspacesVolume: string | null;
  /** The app itself runs in a container, so the daemon cannot resolve its paths as host paths. */
  readonly containerized: boolean;
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
  const workspacesVolume = env.WORKSPACES_VOLUME_NAME?.trim() || null;
  return {
    hotReload,
    workspacesVolume,
    containerized: workspacesVolume !== null,
    hardenedBrowser: !hotReload,
  };
}

export const runtimeMode = readRuntimeMode();
