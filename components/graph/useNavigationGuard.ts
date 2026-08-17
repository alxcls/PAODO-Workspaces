"use client";

// Keeps unsaved edits from leaving silently: in-app navigation is deferred behind a prompt, the
// browser Back button is trapped, and a tab close gets the native warning.
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";

export function useNavigationGuard(isDirty: boolean) {
  const router = useRouter();
  const [destination, setDestination] = useState<string | null>(null);
  const [isPrompting, setIsPrompting] = useState(false);

  const guardedNavigate = useCallback(
    (target: string) => {
      if (!isDirty) {
        router.push(target);
        return;
      }
      setDestination(target);
      setIsPrompting(true);
    },
    [isDirty, router],
  );

  const leave = useCallback(() => router.push(destination ?? "/"), [destination, router]);
  const dismiss = useCallback(() => setIsPrompting(false), []);

  // Browsers won't let JS cancel a popstate, so while dirty we keep re-planting a history entry on
  // top of the stack: Back lands on this same entry and pops the prompt instead of navigating.
  useEffect(() => {
    if (!isDirty) return;
    window.history.pushState(null, "", window.location.href);
    const handlePopState = () => {
      window.history.pushState(null, "", window.location.href);
      setDestination(null);
      setIsPrompting(true);
    };
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, [isDirty]);

  useEffect(() => {
    const handler = (event: BeforeUnloadEvent) => {
      if (isDirty) event.preventDefault();
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [isDirty]);

  return { guardedNavigate, isPrompting, leave, dismiss };
}
