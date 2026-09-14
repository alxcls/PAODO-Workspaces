"use client";

import { useEffect, useRef } from "react";

/** Fires `onReady` exactly once, the first time `ready` becomes true. Resets when the component remounts. */
export function useReadyOnce(ready: boolean, onReady?: () => void) {
  const fired = useRef(false);
  useEffect(() => {
    if (fired.current || !ready) return;
    fired.current = true;
    onReady?.();
  }, [ready, onReady]);
}
