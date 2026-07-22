// Reconnect pacing shared by the workspace WebSocket hooks (useWorkspaceSocket, useConsoleSocket).
//
// Both used to retry on a flat 2s forever. That turns any handshake the browser cannot satisfy into
// an unbounded request loop against the server — and when the rejection carried a Basic-Auth
// challenge, into an unbounded prompt loop against the user. Backing off bounds the damage, and
// admitting the connection is stale gives the user something to act on instead of a silent retry.
//
// Kept out of the hooks so the schedule is one pure function with tests, rather than two copies of
// the same arithmetic drifting apart.

// Capped rather than unbounded: a dropped socket is usually a blip (wifi switch, laptop wake, proxy
// idle-drop) that resolves on its own, so retrying forever at 30s is right. What must not happen is
// retrying *fast* forever.
export const WS_RECONNECT_DELAYS_MS = [2_000, 4_000, 8_000, 15_000, 30_000];

// ±20%, so several hooks (and several tabs) that dropped at the same moment do not come back in
// lockstep and re-drop together.
const JITTER = 0.2;

// `attempt` is 1-based: the delay to wait before the Nth reconnect attempt.
export function wsReconnectDelayMs(attempt: number, random: () => number = Math.random): number {
  const index = Math.min(Math.max(attempt, 1), WS_RECONNECT_DELAYS_MS.length) - 1;
  const base = WS_RECONNECT_DELAYS_MS[index];
  return Math.round(base * (1 + (random() * 2 - 1) * JITTER));
}

// True once the schedule is exhausted, i.e. the socket has failed long enough that this is no longer
// a blip. The most likely cause is a credential the browser can no longer present: the /ws session
// cookie is signed with a per-boot key, so a redeploy invalidates it and only a page load — which
// re-mints it off the still-cached Basic credentials — can restore the socket. Retries continue at
// the capped interval; this only decides whether to tell the user to reload.
export function isWsConnectionStale(attempt: number): boolean {
  return attempt >= WS_RECONNECT_DELAYS_MS.length;
}
