// Home page block for a workspace's internet-access toggle. Binary on/off: when off, the container's
// Docker network has no route out at all — http_get, apt_install, and npm/pip/curl from
// execute_command are all blocked at the network layer, not just hidden from the agent.
// Controlled by the parent (via useWorkspaceInternetAccess) so EnvVarsBlock's "third-party secrets"
// visibility can share the same state and update immediately when this toggle flips.
"use client";

export default function InternetAccessBlock({ enabled, onToggle }: { enabled: boolean; onToggle: () => void }) {
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
          onClick={onToggle}
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
