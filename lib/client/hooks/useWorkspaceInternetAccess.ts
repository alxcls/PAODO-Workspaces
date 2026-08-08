// Loads and toggles a workspace's internet-access flag. Reads as off on every workspace switch
// (and when nothing is selected) so the previous workspace's state never renders under a new
// heading. Lifted to the home page so InternetAccessBlock and EnvVarsBlock share one source of
// truth instead of each polling the endpoint independently and drifting out of sync on toggle.
"use client";

import { useState, useEffect, useCallback } from "react";
import { confirmedValues } from "@/lib/client/workspaceReceipt";

export function useWorkspaceInternetAccess(workspaceId: string | null) {
  const [loaded, setLoaded] = useState<{ id: string; enabled: boolean } | null>(null);

  useEffect(() => {
    if (!workspaceId) return;
    let cancelled = false;
    fetch(`/api/workspaces/${workspaceId}/internet-access`)
      .then((r) => r.json())
      .then((d: { enabled: boolean }) => {
        if (!cancelled) setLoaded({ id: workspaceId, enabled: d.enabled });
      })
      .catch(() => {
        if (!cancelled) setLoaded({ id: workspaceId, enabled: false });
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceId]);

  const enabled = loaded && loaded.id === workspaceId ? loaded.enabled : false;

  // Optimistic: the toggle renders immediately and is rolled back if the PATCH fails, so a
  // rejected save never leaves the switch showing a state the server didn't keep.
  const toggle = useCallback(async () => {
    if (!workspaceId) return;
    const next = !enabled;
    setLoaded({ id: workspaceId, enabled: next });
    const res = await fetch(`/api/workspaces/${workspaceId}/internet-access`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: next }),
    });
    if (!res.ok) {
      setLoaded({ id: workspaceId, enabled: !next });
      return;
    }
    const { internetAccess } = await confirmedValues(res);
    setLoaded({ id: workspaceId, enabled: internetAccess ?? next });
  }, [workspaceId, enabled]);

  return { enabled, toggle };
}
