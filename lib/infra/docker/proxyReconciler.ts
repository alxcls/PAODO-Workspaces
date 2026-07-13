// In-process reconciler that continuously enforces the credential-proxy egress invariant:
// "the credproxy sidecar is attached (with its alias) to every wsnet_* whose workspace is running."
//
// The app attaches the sidecar to each per-workspace network at runtime. Those attachments live on
// the sidecar *container instance*, so recreating it (a redeploy, or rebuilding just the credproxy
// service) silently drops them and black-holes every running workspace's egress. A one-shot heal at
// app boot (reattachProxyNetworks, called from server.ts) misses the case where the sidecar is
// recreated while the app keeps running. This loop closes that gap: a single tick (started once from
// server.ts) periodically re-runs reattachProxyNetworks, so an independent sidecar restart self-heals
// within one interval instead of waiting for the next app reboot.
//
// reattachProxyNetworks() is already prod-guarded (no-op when WORKSPACES_VOLUME_NAME is unset) and
// idempotent (a repeat connect is a no-op), so the tick is cheap and safe to run unconditionally.
import { getContainers } from "../services";
import { createLogger } from "../logger";
import { globalSingleton } from "../globalSingleton";

const log = createLogger("proxyReconciler");

const DEFAULT_TICK_MS = 60_000;

type ReconcilerState = { timer: NodeJS.Timeout | null; running: boolean };
const state = globalSingleton<ReconcilerState>("proxyReconcilerState", () => ({ timer: null, running: false }));

async function tick(): Promise<void> {
  // Skip if a prior tick is still in flight (docker calls can be slow) so ticks never pile up.
  if (state.running) return;
  state.running = true;
  try {
    await getContainers().reattachProxyNetworks();
  } catch (err) {
    log.warn({ err }, "proxy reconcile tick failed");
  } finally {
    state.running = false;
  }
}

/** Start the reconcile loop. Idempotent. */
export function startProxyReconciler(): void {
  if (state.timer) return;
  const tickMs = parseInt(process.env.PROXY_RECONCILE_TICK_MS ?? String(DEFAULT_TICK_MS), 10) || DEFAULT_TICK_MS;
  state.timer = setInterval(tick, tickMs);
  state.timer.unref?.();
  log.info({ tickMs }, "proxy reconciler started");
}

export function stopProxyReconciler(): void {
  if (!state.timer) return;
  clearInterval(state.timer);
  state.timer = null;
  log.info("proxy reconciler stopped");
}

// Exported for tests to drive a single reconcile deterministically.
export { tick as _reconcileTick };
