// Runs an async action while exposing a `pending` flag that only turns true if the action is still
// running after `delayMs`. Fast actions finish before the timer fires and never flash a spinner;
// slow ones surface one. Re-entrant calls are ignored while an action is in flight (the guard is a
// ref, not the lagging `pending` state, so it blocks duplicates during the pre-delay window too).
//
// Usage:
//   const { pending, run } = useDeferredPending();
//   <button disabled={pending} onClick={() => run(async () => { ...await... })}>
//     {pending ? "Working…" : "Go"}
//   </button>

import { useCallback, useRef, useState } from "react";

export function useDeferredPending(delayMs = 1000) {
  const [pending, setPending] = useState(false);
  const runningRef = useRef(false);

  const run = useCallback(
    async <T>(action: () => Promise<T>): Promise<T | undefined> => {
      if (runningRef.current) return undefined;
      runningRef.current = true;
      const timer = window.setTimeout(() => setPending(true), delayMs);
      try {
        return await action();
      } finally {
        clearTimeout(timer);
        runningRef.current = false;
        setPending(false);
      }
    },
    [delayMs],
  );

  return { pending, run };
}
