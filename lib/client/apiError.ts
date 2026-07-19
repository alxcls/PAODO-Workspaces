/** Pull the server's `{ error }` message off a failed response, falling back to a generic message.
 *  The body is read defensively: a non-JSON error page (proxy 502, HTML error) must surface the
 *  caller's fallback rather than throwing over the original failure. */
export async function readErrorMessage(res: Response, fallback: string): Promise<string> {
  try {
    const body = (await res.json()) as { error?: string };
    return body.error || fallback;
  } catch {
    return fallback;
  }
}

/** Outcome of a mutation whose failure message is shown inline (create/rename forms stay open so
 *  the user can correct the input), rather than thrown. */
export type MutationResult = { ok: true } | { ok: false; error: string };
