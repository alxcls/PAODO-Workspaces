// Fetches a workspace's metadata from GET /api/workspaces/:id when the id changes.
//
// Returns null until the fetch resolves, and for a null id, so callers can distinguish "not loaded"
// from "loaded" instead of rendering a placeholder date built from undefined. Errors are swallowed:
// the UI shows nothing rather than breaking.
//
// The route returns more than this (run limits, model, internet access); only the display fields are
// typed here, since the panels that need the rest fetch it themselves.
"use client";

import { useEffect, useState } from "react";

export interface WorkspaceMeta {
  id: string;
  name: string;
  /** ISO-8601 string as serialized by the route, not a Date. */
  createdAt: string;
}

export function useWorkspaceMeta(workspaceId: string | null): WorkspaceMeta | null {
  // The id the loaded metadata belongs to is kept alongside it so the result can be derived rather
  // than reset in an effect. Without that pairing, switching workspaces would return the previous
  // one's metadata until the new request resolved.
  const [loaded, setLoaded] = useState<{ id: string; meta: WorkspaceMeta } | null>(null);

  useEffect(() => {
    if (!workspaceId) return;
    // `active` drops a response that arrives after the id changed or the component unmounted.
    let active = true;
    void (async () => {
      try {
        const response = await fetch(`/api/workspaces/${workspaceId}`);
        if (!response.ok) return;
        const meta = (await response.json()) as WorkspaceMeta;
        if (active) setLoaded({ id: workspaceId, meta });
      } catch {
        /* leave it unloaded — the caller renders a placeholder */
      }
    })();
    return () => {
      active = false;
    };
  }, [workspaceId]);

  return loaded && loaded.id === workspaceId ? loaded.meta : null;
}
