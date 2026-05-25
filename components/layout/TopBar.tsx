import type { ReactNode } from "react";

export default function TopBar({
  left,
  right,
  error,
}: {
  left?: ReactNode;
  right?: ReactNode;
  error?: string | null;
}) {
  return (
    <div className="flex items-center gap-2.5 px-4 h-12 flex-shrink-0 bg-bg border-b border-border">
      <div className="flex items-center gap-2 flex-1 min-w-0">{left}</div>
      {error && <span className="text-xs text-danger font-medium mr-1">{error}</span>}
      <div className="flex items-center gap-2 ml-auto flex-shrink-0">{right}</div>
    </div>
  );
}
