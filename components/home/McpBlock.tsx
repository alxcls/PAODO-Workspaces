// Home page block for managing a workspace's MCP endpoint.
// Enable/disable the MCP, mint a bearer secret (shown once) and revoke it, pick which skills are
// published, and copy the connection URL to paste into an external MCP client.
//
// The credential lifecycle and chrome are shared with the API-access block (useCredential /
// CredentialPanel). What is genuinely MCP-specific — the published-skill selection — lives here.
"use client";

import { useState } from "react";
import CredentialPanel from "@/components/shared/CredentialPanel";
import { useCredential } from "@/lib/client/hooks/useCredential";

interface AvailableSkill {
  id: string;
  description: string;
}

interface McpExtra {
  selectedSkillIds: string[];
  availableSkills: AvailableSkill[];
  publicBaseUrl: string | null;
}

export default function McpBlock({ wsId }: { wsId: string }) {
  const endpoint = `/api/workspaces/${wsId}/mcp-config`;
  const credential = useCredential<McpExtra>(endpoint, { noun: "secret", feature: "MCP settings" });

  // The server's selection is the source of truth until the user edits it; `edited` holds the local
  // override from that point on. Deriving rather than mirroring into an effect avoids a cascading
  // render and the flicker of rendering an empty selection before the fetch resolves.
  const [edited, setEdited] = useState<string[] | null>(null);
  const [savingSkills, setSavingSkills] = useState(false);

  const selected = edited ?? credential.extra?.selectedSkillIds ?? [];
  const skills = credential.extra?.availableSkills ?? [];
  const origin = credential.extra?.publicBaseUrl ?? (typeof window !== "undefined" ? window.location.origin : "");
  const url = `${origin}/api/workspaces/${wsId}/mcp`;

  const toggleSkill = async (id: string) => {
    const next = selected.includes(id) ? selected.filter((s) => s !== id) : [...selected, id];
    setSavingSkills(true);
    credential.setError(null);
    try {
      const response = await fetch(endpoint, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ selectedSkillIds: next }),
      });
      if (!response.ok) throw new Error("Could not update published skills.");
      setEdited(next);
    } catch (err) {
      credential.setError(err instanceof Error ? err.message : "Could not update published skills.");
    } finally {
      setSavingSkills(false);
    }
  };

  const busy = credential.busy || savingSkills;

  return (
    <CredentialPanel
      title="Workspace MCP access"
      noun="secret"
      toggleLabel="Workspace MCP"
      description="Exposes selected skills as MCP tools to external AI clients with a dedicated bearer secret."
      enabled={credential.enabled}
      hasSecret={credential.hasSecret}
      secret={credential.secret}
      busy={busy}
      error={credential.error}
      onToggle={credential.toggle}
      onMint={credential.mint}
      onRevoke={credential.revoke}
      onDismissSecret={credential.dismissSecret}
    >
      {(credential.hasSecret || credential.secret) && (
        <div className="flex flex-col gap-1">
          <span className="text-xs font-medium text-text">Connection URL</span>
          <code className="font-mono text-[12px] font-medium leading-[1.5] text-text bg-white px-2 py-1 rounded border border-border min-w-0 break-all">
            {url}
          </code>
        </div>
      )}

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
                disabled={busy}
              />
              <div className="flex flex-col min-w-0">
                <code className="font-mono text-[12px] font-medium leading-[1.35] text-text break-all">{s.id}</code>
                {s.description && <span className="mt-1 text-xs leading-[1.5] text-text-2">{s.description}</span>}
              </div>
            </label>
          ))
        )}
      </div>
    </CredentialPanel>
  );
}
