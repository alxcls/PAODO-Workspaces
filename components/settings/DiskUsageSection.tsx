// Storage usage on the host VPS, as one section of the settings modal.
//
// Reads /api/settings/disk-usage, which measures the real mounted filesystem, so it works on any
// provider with no provider-specific code. Outside the container the path is absent and the endpoint
// reports available:false, which shows as an "unavailable" line rather than a bar.
"use client";

import { useEffect, useState } from "react";

interface DiskUsage {
  available: boolean;
  total?: number;
  used?: number;
  free?: number;
}

function formatBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(value < 10 && unit > 0 ? 1 : 0)} ${units[unit]}`;
}

export default function DiskUsageSection({ open }: { open: boolean }) {
  const [usage, setUsage] = useState<DiskUsage | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setError(null);
    fetch("/api/settings/disk-usage", { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
      .then((data: DiskUsage) => {
        if (!cancelled) setUsage(data);
      })
      .catch((err: Error) => {
        if (!cancelled) setError(err.message);
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  const ready = usage?.available && usage.total && usage.total > 0;
  const percent = ready ? Math.min(100, Math.round((usage!.used! / usage!.total!) * 100)) : 0;

  return (
    <section>
      <span className="text-sm font-semibold">Storage</span>

      {error && (
        <p role="alert" className="mb-0 mt-3 text-xs text-danger">
          {error}
        </p>
      )}

      {!error && !usage && <p className="mb-0 mt-3 text-xs text-text-3">Loading…</p>}

      {!error && usage && !ready && (
        <p className="mb-0 mt-3 text-xs text-text-3">Storage usage is unavailable in this environment.</p>
      )}

      {ready && (
        <div className="mt-4 flex flex-col gap-2">
          <div className="h-2.5 w-full overflow-hidden rounded-full bg-bg-deep">
            <div
              className="h-full rounded-full bg-primary transition-[width] duration-300"
              style={{ width: `${percent}%` }}
              role="progressbar"
              aria-valuenow={percent}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-label="Disk usage"
            />
          </div>
          <div className="flex items-center justify-between text-xs text-text-2">
            <span>
              {formatBytes(usage!.used!)} used of {formatBytes(usage!.total!)}
            </span>
            <span>{formatBytes(usage!.free!)} free</span>
          </div>
        </div>
      )}
    </section>
  );
}
