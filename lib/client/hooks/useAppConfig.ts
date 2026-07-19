// Reads the server's client-visible feature flags (/api/config) once on mount. Flags default to
// off until the fetch resolves, and a failed fetch leaves them off — an optional feature stays
// hidden rather than rendering an entry point that would 404.
"use client";

import { useState, useEffect } from "react";

export interface AppConfig {
  graphEnabled: boolean;
}

export function useAppConfig(): AppConfig {
  const [graphEnabled, setGraphEnabled] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/config")
      .then((r) => r.json())
      .then((cfg: Partial<AppConfig>) => {
        if (!cancelled) setGraphEnabled(cfg.graphEnabled ?? false);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  return { graphEnabled };
}
