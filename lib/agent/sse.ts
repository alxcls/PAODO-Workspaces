// Shared Server-Sent-Events plumbing for the two streaming endpoints: the UI chat route
// (app/api/workspaces/[id]/chat) and the public agent routes. Both emit one
// `data: <json>\n\n` frame per event, and both need the same defence against idle disconnects.
//
// Why the keepalive: these streams send bytes only when the agent emits an event, and a run can go
// completely silent for a long time — the chat stream sends nothing between `tool_start` and
// `tool_result`, while a single command may legally run for EXEC_MAX_TIMEOUT_MS (30 min). A
// command's own output goes to the terminal WebSocket, not here, so it does nothing to keep this
// connection warm. Proxies do not tolerate that silence (Cloudflare drops an idle stream in ~100s),
// and because the run is owned by the run broker rather than the request, the agent would keep
// working and finish while the viewer's connection was already dead — surfacing as a bogus
// "Failed to reach server" in a tab whose task actually succeeded.
//
// The fix is a comment frame on a fixed interval. SSE comments carry no data and every consumer
// here ignores any line that is not `data: ` (see lib/client/sse.ts), so this stays invisible to
// clients and needs no protocol change.

export const SSE_HEADERS = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache, no-transform",
  Connection: "keep-alive",
  "X-Accel-Buffering": "no",
} as const;

/** Comfortably under the ~100s idle window proxies allow, without adding meaningful traffic. */
export const SSE_KEEPALIVE_MS = 15_000;

const KEEPALIVE_FRAME = ": ping\n\n";

/**
 * Emit a comment frame every SSE_KEEPALIVE_MS so the connection survives silent stretches.
 * Returns the stop function; callers must invoke it before closing the stream.
 */
export function startKeepalive(
  controller: ReadableStreamDefaultController<Uint8Array>,
  encoder: TextEncoder,
  intervalMs: number = SSE_KEEPALIVE_MS,
): () => void {
  const timer = setInterval(() => {
    try {
      controller.enqueue(encoder.encode(KEEPALIVE_FRAME));
    } catch {
      /* stream already closed — nothing to keep alive */
    }
  }, intervalMs);
  // A finished run must not keep a Node process alive merely because its keepalive remains.
  timer.unref?.();
  return () => clearInterval(timer);
}
