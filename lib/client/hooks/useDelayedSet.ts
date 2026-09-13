"use client";

import { useEffect, useMemo, useRef, useState } from "react";

/** Mirror a set, but let each member appear only after it has stayed in the source past delayMs. */
export function useDelayedSet(source: Set<string>, delayMs: number): Set<string> {
  const [agedIn, setAgedIn] = useState<Set<string>>(() => new Set());
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  useEffect(() => {
    for (const key of source) {
      if (agedIn.has(key) || timers.current.has(key)) continue;
      const timer = setTimeout(() => {
        timers.current.delete(key);
        setAgedIn((prev) => new Set(prev).add(key));
      }, delayMs);
      timers.current.set(key, timer);
    }
    for (const [key, timer] of timers.current) {
      if (source.has(key)) continue;
      clearTimeout(timer);
      timers.current.delete(key);
    }
  }, [source, delayMs, agedIn]);

  useEffect(() => {
    const pending = timers.current;
    return () => {
      pending.forEach((timer) => clearTimeout(timer));
      pending.clear();
    };
  }, []);

  return useMemo(() => new Set([...agedIn].filter((key) => source.has(key))), [agedIn, source]);
}
