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
    <div className="topbar">
      <div className="topbar-left">{left}</div>
      {error && <span className="topbar-error">{error}</span>}
      <div className="topbar-right">{right}</div>
    </div>
  );
}
