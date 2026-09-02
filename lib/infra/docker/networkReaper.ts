// In-process sweep that lazily reclaims per-workspace Docker networks. stop() empties a workspace's
// network on idle but no longer deletes it inline: deleting the bridge reloads the host's firewall
// and routing, which briefly disrupts unrelated egress (the Cloudflare tunnel would blip). Emptied
// networks therefore accumulate; this loop removes the ones that have stayed empty across a grace
// window. sweepManagedNetworks() is idempotent and self-throttling, so the tick is cheap and safe.
import { getContainers } from "../services";
import { createLogger } from "../logger";
import { globalSingleton } from "../globalSingleton";

const log = createLogger("networkReaper");

const DEFAULT_TICK_MS = 600_000;

type ReaperState = {
  timer: NodeJS.Timeout | null;
  running: boolean;
};
const state = globalSingleton<ReaperState>("networkReaperState", () => ({
  timer: null,
  running: false,
}));

function graceMs(): number | undefined {
  const configured = Number(process.env.NETWORK_REAP_GRACE_MS);
  return Number.isFinite(configured) && configured >= 0 ? configured : undefined;
}

async function tick(): Promise<void> {
  // Skip if a prior tick is still in flight (docker calls can be slow) so ticks never pile up.
  if (state.running) return;
  state.running = true;
  try {
    await getContainers().sweepManagedNetworks(graceMs());
  } catch (err) {
    log.warn({ err }, "network reaper tick failed");
  } finally {
    state.running = false;
  }
}

/** Start the sweep loop. Idempotent. */
export function startNetworkReaper(): void {
  if (state.timer) return;
  const configuredTickMs = Number(process.env.NETWORK_REAP_TICK_MS);
  const tickMs = Number.isFinite(configuredTickMs) && configuredTickMs > 0 ? configuredTickMs : DEFAULT_TICK_MS;
  state.timer = setInterval(tick, tickMs);
  state.timer.unref?.();
  log.info({ tickMs }, "network reaper started");
}

export function stopNetworkReaper(): void {
  if (!state.timer) return;
  clearInterval(state.timer);
  state.timer = null;
  log.info("network reaper stopped");
}

// Exported for tests to drive a single sweep deterministically.
export { tick as _reapTick };
