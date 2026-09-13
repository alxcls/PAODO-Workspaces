"use client";

import { SPINNER_DELAY_MS, useDelayed } from "@/lib/client/hooks/useDelayed";
import { Spinner } from "./Spinner";

/** Centered loading feedback; the parent controls the available space. Shows only once it has been
 *  on screen past delayMs, so a load that resolves quickly never flashes a spinner. Pass delayMs={0}
 *  to render at once — right for a surface the user just opened, where a blank beats a delay. */
export function LoadingState({
  label = "Loading…",
  className = "",
  delayMs = SPINNER_DELAY_MS,
}: {
  label?: string;
  className?: string;
  delayMs?: number;
}) {
  const passedDelay = useDelayed(true, delayMs);
  if (delayMs > 0 && !passedDelay) return null;
  return (
    <div className={`flex items-center justify-center text-text-3 text-[13px] ${className}`}>
      <div className="flex items-center gap-2" role="status">
        <Spinner decorative />
        <span>{label}</span>
      </div>
    </div>
  );
}
