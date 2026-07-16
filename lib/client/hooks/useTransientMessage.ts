// Holds a message that clears itself `ms` after it is set — for transient failure text that should
// not linger. Setting a different message restarts the window; the effect cleanup cancels any
// pending clear, so an unmount or a replacement never fires a stale one.
//
// Usage:
//   const [error, setError] = useTransientMessage(2000);
//   {error && <div className="text-danger">{error}</div>}

import { useEffect, useState } from "react";

export function useTransientMessage(ms: number) {
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    if (message === null) return;
    const timer = window.setTimeout(() => setMessage(null), ms);
    return () => window.clearTimeout(timer);
  }, [message, ms]);

  return [message, setMessage] as const;
}
