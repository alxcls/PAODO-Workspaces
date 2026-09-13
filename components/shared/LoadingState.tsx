"use client";

import { SPINNER_DELAY_MS, useDelayed } from "@/lib/client/hooks/useDelayed";
import { Spinner } from "./Spinner";

/** Centered loading feedback; the parent controls the available space. Shows only once it has been
 *  on screen past delayMs, so a load that resolves quickly never flashes a spinner. */
export function LoadingState({
  label = "Loading…",
  className = "",
  delayMs = SPINNER_DELAY_MS,
}: {
  label?: string;
  className?: string;
  delayMs?: number;
}) {
  if (!useDelayed(true, delayMs)) return null;
  return (
    <div className={`flex items-center justify-center text-text-3 text-[13px] ${className}`}>
      <div className="flex items-center gap-2" role="status">
        <Spinner decorative />
        <span>{label}</span>
      </div>
    </div>
  );
}
