// Home page block for managing a workspace's external API access.
// Lets the user enable/disable access, generate a new key (plaintext shown once), and revoke it.
"use client";

import { useState, useEffect } from "react";

export default function ApiAccessBlock({ wsId }: { wsId: string }) {
  const [enabled, setEnabled] = useState(false);
  const [hasKey, setHasKey] = useState(false);
  const [newKey, setNewKey] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    fetch(`/api/workspaces/${wsId}/api-key`)
      .then((r) => r.json())
      .then((d: { enabled: boolean; hasKey: boolean }) => { setEnabled(d.enabled); setHasKey(d.hasKey); })
      .catch(() => {});
  }, [wsId]);

  const toggle = async () => {
    const next = !enabled;
    setEnabled(next);
    await fetch(`/api/workspaces/${wsId}/api-key`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: next }),
    });
  };

  const generate = async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/workspaces/${wsId}/api-key`, { method: "POST" });
      const { plain } = (await res.json()) as { plain: string };
      setNewKey(plain); setHasKey(true); setEnabled(true);
    } finally { setLoading(false); }
  };

  const revoke = async () => {
    await fetch(`/api/workspaces/${wsId}/api-key`, { method: "DELETE" });
    setHasKey(false); setNewKey(null);
  };

  const copy = () => {
    if (!newKey) return;
    navigator.clipboard.writeText(newKey);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="flex flex-col gap-3 mt-4 border border-border rounded-card p-[14px_16px] bg-bg-tint">
      <div className="flex items-center justify-between">
        <div>
          <span className="text-ms font-semibold text-text">API Access</span>
          <span className="text-xs text-text-3 ml-2">{enabled ? "Enabled" : "Disabled"}</span>
        </div>
        <button
          className={`relative w-9 h-5 rounded-[10px] border-0 cursor-pointer transition-colors duration-200 p-0 flex-shrink-0 ${enabled ? "bg-primary" : "bg-border"}`}
          onClick={toggle}
          aria-label={enabled ? "Disable API access" : "Enable API access"}
        >
          <span
            className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white transition-transform duration-200 block ${enabled ? "translate-x-4" : ""}`}
          />
        </button>
      </div>

      {enabled && !hasKey && !newKey && (
        <button className="btn btn-sm" onClick={generate} disabled={loading}>
          {loading ? "Generating…" : "Generate API Key"}
        </button>
      )}

      {enabled && hasKey && !newKey && (
        <div className="flex items-center gap-2.5">
          <span className="text-ms font-medium text-select">Key active</span>
          <button className="linkbtn text-danger" onClick={revoke}>Revoke</button>
        </div>
      )}

      {newKey && (
        <div className="bg-white border border-border rounded-ctrl p-[12px_14px] flex flex-col gap-2">
          <p className="m-0 text-xs text-danger font-medium">Save this key — it won&apos;t be shown again.</p>
          <div className="flex items-center gap-2">
            <code className="font-mono text-xs leading-[1.4] text-text bg-bg-tint px-2 py-1 rounded border border-border flex-1 min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">
              {newKey}
            </code>
            <button className="btn btn-sm" onClick={copy}>{copied ? "Copied!" : "Copy"}</button>
          </div>
          <button className="linkbtn" onClick={() => setNewKey(null)}>Dismiss</button>
        </div>
      )}
    </div>
  );
}
