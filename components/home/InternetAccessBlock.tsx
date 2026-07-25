// Home page block for a workspace's internet-access toggle. Binary on/off: when off, the container's
// Docker network has no route out at all — http_get, apt_install, and npm/pip/curl from
// execute_command are all blocked at the network layer, not just hidden from the agent.
"use client";

import { useState, useEffect } from "react";

export default function InternetAccessBlock({ wsId }: { wsId: string }) {
  const [enabled, setEnabled] = useState(false);

  useEffect(() => {
    fetch(`/api/workspaces/${wsId}/internet-access`)
      .then((r) => r.json())
      .then((d: { enabled: boolean }) => setEnabled(d.enabled))
      .catch(() => {});
  }, [wsId]);

  const toggle = async () => {
    const next = !enabled;
    setEnabled(next);
    await fetch(`/api/workspaces/${wsId}/internet-access`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: next }),
    });
  };

  return (
    <div className="flex flex-col gap-4 mt-4 border border-border rounded-card p-[16px_18px] bg-bg-tint">
      <div className="flex items-center justify-between">
        <div className="min-w-0">
          <span className="text-ms font-semibold text-text">Internet access</span>
          <span className={`text-xs ml-2 ${enabled ? "text-select" : "text-text-3"}`}>
            {enabled ? "On" : "Off"}
          </span>
        </div>
        <button
          className={`relative w-9 h-5 rounded-[10px] border-0 cursor-pointer transition-colors duration-200 p-0 flex-shrink-0 ${enabled ? "bg-primary" : "bg-border"}`}
          onClick={toggle}
          aria-label={enabled ? "Disable internet access" : "Enable internet access"}
        >
          <span
            className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white transition-transform duration-200 block ${enabled ? "translate-x-4" : ""}`}
          />
        </button>
      </div>

      {!enabled && (
        <p className="m-0 text-xs text-text-3">
          This workspace&apos;s container has no network route to the internet. apt/pip/npm installs,
          http_get, and configured secret-domain access are all blocked. Safe to leave the agent running
          unattended.
        </p>
      )}
    </div>
  );
}
