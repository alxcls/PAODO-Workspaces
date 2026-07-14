// Home page block for managing a workspace's MCP endpoint.
// Enable/disable the MCP, mint a bearer secret (shown once) and revoke it, pick which skills are
// published, and copy the connection URL to paste into an external MCP client.
"use client";

import { useState, useEffect } from "react";

interface AvailableSkill {
  id: string;
  name: string;
  description: string;
}

interface McpConfig {
  enabled: boolean;
  hasSecret: boolean;
  selectedSkillIds: string[];
  availableSkills: AvailableSkill[];
  publicBaseUrl: string | null;
}

export default function McpBlock({ wsId }: { wsId: string }) {
  const [enabled, setEnabled] = useState(false);
  const [hasSecret, setHasSecret] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [skills, setSkills] = useState<AvailableSkill[]>([]);
  const [newSecret, setNewSecret] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);
  const [publicBaseUrl, setPublicBaseUrl] = useState<string | null>(null);

  useEffect(() => {
    fetch(`/api/workspaces/${wsId}/mcp-config`)
      .then((r) => r.json())
      .then((d: McpConfig) => {
        setEnabled(d.enabled);
        setHasSecret(d.hasSecret);
        setSelected(d.selectedSkillIds);
        setSkills(d.availableSkills);
        setPublicBaseUrl(d.publicBaseUrl);
      })
      .catch(() => {});
  }, [wsId]);

  const origin = publicBaseUrl ?? (typeof window !== "undefined" ? window.location.origin : "");
  const url = `${origin}/api/workspaces/${wsId}/mcp`;

  const toggle = async () => {
    const next = !enabled;
    setEnabled(next);
    await fetch(`/api/workspaces/${wsId}/mcp-config`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: next }),
    });
  };

  const mint = async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/workspaces/${wsId}/mcp-config`, { method: "POST" });
      const { plain } = (await res.json()) as { plain: string };
      setNewSecret(plain);
      setHasSecret(true);
      setEnabled(true);
    } finally {
      setLoading(false);
    }
  };

  const revoke = async () => {
    await fetch(`/api/workspaces/${wsId}/mcp-config`, { method: "DELETE" });
    setHasSecret(false);
    setNewSecret(null);
  };

  const persistSelection = async (ids: string[]) => {
    setSelected(ids);
    await fetch(`/api/workspaces/${wsId}/mcp-config`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ selectedSkillIds: ids }),
    });
  };

  const toggleSkill = (id: string) => {
    const next = selected.includes(id) ? selected.filter((s) => s !== id) : [...selected, id];
    persistSelection(next);
  };

  const copySecret = (text: string) => {
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="flex flex-col gap-4 mt-4 border border-border rounded-card p-[16px_18px] bg-bg-tint">
      <div className="flex items-center justify-between">
        <div className="min-w-0">
          <span className="text-ms font-semibold text-text">Workspace MCP access</span>
          <span className={`text-xs ml-2 ${enabled && hasSecret ? "text-select" : "text-text-3"}`}>
            {enabled ? (hasSecret ? "Secret active" : "Secret required") : "Disabled"}
          </span>
        </div>
        <button
          className={`relative w-9 h-5 rounded-[10px] border-0 cursor-pointer transition-colors duration-200 p-0 flex-shrink-0 ${enabled ? "bg-primary" : "bg-border"}`}
          onClick={toggle}
          aria-label={enabled ? "Disable Workspace MCP" : "Enable Workspace MCP"}
        >
          <span
            className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white transition-transform duration-200 block ${enabled ? "translate-x-4" : ""}`}
          />
        </button>
      </div>

      {enabled && (
        <>
          <p className="m-0 text-xs text-text-3">
            Exposes selected skills as MCP tools to external AI clients with a dedicated bearer secret.
          </p>

          {(hasSecret || newSecret) && (
            <div className="flex flex-col gap-1">
              <span className="text-xs font-medium text-text">Connection URL</span>
              <code className="font-mono text-[12px] font-medium leading-[1.5] text-text bg-white px-2 py-1 rounded border border-border min-w-0 break-all">
                {url}
              </code>
            </div>
          )}

          {/* Published skills */}
          <div className="flex flex-col gap-2">
            <span className="text-xs font-medium text-text">Published skills ({selected.length})</span>
            {skills.length === 0 ? (
              <p className="m-0 text-xs text-text-3">This workspace declares no skills yet.</p>
            ) : (
              skills.map((s) => (
                <label
                  key={s.id}
                  className="flex items-start gap-3 bg-white border border-border rounded-ctrl px-3 py-2.5 cursor-pointer"
                >
                  <input
                    type="checkbox"
                    className="mt-0.5"
                    checked={selected.includes(s.id)}
                    onChange={() => toggleSkill(s.id)}
                  />
                  <div className="flex flex-col min-w-0">
                    <code className="font-mono text-[12px] font-medium leading-[1.35] text-text break-all">{s.id}</code>
                    {s.description && <span className="mt-1 text-xs leading-[1.5] text-text-2">{s.description}</span>}
                  </div>
                </label>
              ))
            )}
          </div>

          {!hasSecret && !newSecret && (
            <button className="btn btn-sm self-start" onClick={mint} disabled={loading}>
              {loading ? "Generating…" : "Generate secret"}
            </button>
          )}

          {hasSecret && !newSecret && (
            <div className="flex items-center gap-2.5">
              <button className="linkbtn" onClick={mint} disabled={loading}>Rotate</button>
              <button className="linkbtn text-danger" onClick={revoke}>Revoke</button>
            </div>
          )}

          {newSecret && (
            <div className="bg-white border border-border rounded-ctrl p-[12px_14px] flex flex-col gap-2">
              <p className="m-0 text-xs text-danger font-medium">Save this secret — it won&apos;t be shown again.</p>
              <div className="flex items-start gap-2">
                <code className="font-mono text-xs leading-[1.4] text-text bg-bg-tint px-2 py-1 rounded border border-border flex-1 min-w-0 break-all">
                  {newSecret}
                </code>
                <button className="btn btn-sm" onClick={() => copySecret(newSecret)}>{copied ? "Copied!" : "Copy"}</button>
              </div>
              <button className="linkbtn" onClick={() => setNewSecret(null)}>Close</button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
