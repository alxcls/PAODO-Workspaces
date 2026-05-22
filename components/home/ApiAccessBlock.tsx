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
      .then((d: { enabled: boolean; hasKey: boolean }) => {
        setEnabled(d.enabled);
        setHasKey(d.hasKey);
      })
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
      setNewKey(plain);
      setHasKey(true);
      setEnabled(true);
    } finally {
      setLoading(false);
    }
  };

  const revoke = async () => {
    await fetch(`/api/workspaces/${wsId}/api-key`, { method: "DELETE" });
    setHasKey(false);
    setNewKey(null);
  };

  const copy = () => {
    if (!newKey) return;
    navigator.clipboard.writeText(newKey);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="api-access-block">
      <div className="api-access-row">
        <div>
          <span className="api-access-label">API Access</span>
          <span className="api-access-status">{enabled ? "Enabled" : "Disabled"}</span>
        </div>
        <button
          className={"api-toggle" + (enabled ? " is-on" : "")}
          onClick={toggle}
          aria-label={enabled ? "Disable API access" : "Enable API access"}
        >
          <span className="api-toggle-knob" />
        </button>
      </div>

      {enabled && !hasKey && !newKey && (
        <button className="btn btn-sm" onClick={generate} disabled={loading}>
          {loading ? "Generating…" : "Generate API Key"}
        </button>
      )}

      {enabled && hasKey && !newKey && (
        <div className="api-key-row">
          <span className="api-key-status">Key active</span>
          <button className="linkbtn" style={{ color: "var(--danger)" }} onClick={revoke}>
            Revoke
          </button>
        </div>
      )}

      {newKey && (
        <div className="api-key-reveal">
          <p className="api-key-warning">Save this key — it won&apos;t be shown again.</p>
          <div className="api-key-display">
            <code className="api-key-value">{newKey}</code>
            <button className="btn btn-sm" onClick={copy}>
              {copied ? "Copied!" : "Copy"}
            </button>
          </div>
          <button className="linkbtn" onClick={() => setNewKey(null)}>Dismiss</button>
        </div>
      )}
    </div>
  );
}
