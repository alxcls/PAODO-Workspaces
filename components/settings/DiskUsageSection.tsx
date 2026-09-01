// Storage usage on the host VPS, as one section of the settings modal.
//
// Reads /api/settings/disk-usage, which measures the real mounted filesystem, so it works on any
// provider with no provider-specific code. Outside the container the path is absent and the endpoint
// reports available:false, which shows as an "unavailable" line rather than a bar.
"use client";

import { useEffect, useState } from "react";
import { formatBytes } from "@/lib/uploads/limits";

interface DiskUsage {
  available: boolean;
  total?: number;
  used?: number;
  free?: number;
}

export default function DiskUsageSection({ open }: { open: boolean }) {
  const [usage, setUsage] = useState<DiskUsage | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    fetch("/api/settings/disk-usage", { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
      .then((data: DiskUsage) => {
        if (!cancelled) setUsage(data);
      })
      .catch((err: Error) => {
        if (!cancelled) setError(err.message);
      });
    // Reset on close so a reopen starts from the loading state, never a stale bar or error.
    return () => {
      cancelled = true;
      setUsage(null);
      setError(null);
    };
  }, [open]);

  const view =
    usage?.available && usage.total && usage.used != null && usage.free != null
      ? {
          used: usage.used,
          total: usage.total,
          free: usage.free,
          percent: Math.min(100, Math.round((usage.used / usage.total) * 100)),
        }
      : null;

  return (
    <section>
      <span className="text-sm font-semibold">Storage</span>

      {error && (
        <p role="alert" className="mb-0 mt-3 text-xs text-danger">
          {error}
        </p>
      )}

      {!error && !usage && <p className="mb-0 mt-3 text-xs text-text-3">Loading…</p>}

      {!error && usage && !view && (
        <p className="mb-0 mt-3 text-xs text-text-3">Storage usage is unavailable in this environment.</p>
      )}

      {view && (
        <div className="mt-4 flex flex-col gap-2">
          <div className="h-2.5 w-full overflow-hidden rounded-full bg-bg-deep">
            <div
              className="h-full rounded-full bg-primary transition-[width] duration-300"
              style={{ width: `${view.percent}%` }}
              role="progressbar"
              aria-valuenow={view.percent}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-label="Disk usage"
            />
          </div>
          <div className="flex items-center justify-between text-xs text-text-2">
            <span>
              {formatBytes(view.used)} used of {formatBytes(view.total)}
            </span>
            <span>{formatBytes(view.free)} free</span>
          </div>
        </div>
      )}
    </section>
  );
}
