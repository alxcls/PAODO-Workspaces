"use client";

import { LoadingState } from "./LoadingState";

interface Props {
  loading: boolean;
  error: boolean;
  onRetry?: () => void;
  loadingLabel?: string;
  errorLabel?: string;
  /** Delay before the loading indicator shows. Pass 0 on a just-opened surface (e.g. a modal) so the
   *  body loads at once rather than sitting blank while the surrounding chrome is already painted. */
  loadingDelayMs?: number;
  /** Extra classes for the wrapper, e.g. a tighter padding inside a small card. */
  className?: string;
}

export function AsyncState({
  loading,
  error,
  onRetry,
  loadingLabel = "Loading…",
  errorLabel = "Couldn’t load.",
  loadingDelayMs,
  className = "",
}: Props) {
  if (loading) {
    return <LoadingState label={loadingLabel} delayMs={loadingDelayMs} className={`py-8 ${className}`} />;
  }
  if (error) {
    return (
      <div className={`flex flex-col items-center gap-2 py-8 px-4 text-center text-[13px] text-text-3 ${className}`}>
        <span>{errorLabel}</span>
        {onRetry && (
          <button type="button" className="btn btn-ghost btn-sm" onClick={onRetry}>
            Retry
          </button>
        )}
      </div>
    );
  }
  return null;
}
