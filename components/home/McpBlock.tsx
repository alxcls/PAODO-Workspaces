// Home page block for managing a workspace's MCP endpoint.
// Enable/disable the MCP, mint a bearer key (shown once) and revoke it, and copy the connection URL
// to paste into an external MCP client.
//
// The credential lifecycle and chrome are shared with the API-access block (useCredential /
// CredentialPanel). What is genuinely MCP-specific — the exposed tool list and the connection URL —
// lives here.
//
// The tool list is read-only by design: enabling the endpoint exposes every skill in .skills/, so
// what is listed is whatever the workspace agent has declared. Showing it still matters — it is where
// you see that the agent added or removed a tool your client depends on.
"use client";

import CredentialPanel from "@/components/shared/CredentialPanel";
import { useCredential } from "@/lib/client/hooks/useCredential";
// Type-only import: the shape is owned by lib/operations, which both this block and the CLI read.
import type { ExposedSkill } from "@/lib/operations/workspaceSkills";

interface McpExtra {
  exposedSkills: ExposedSkill[];
  publicBaseUrl: string | null;
}

// Module scope, not an inline literal: the options object is a dependency of the hook's callbacks, so
// a fresh one each render would rebuild them every time.
const LABELS = { feature: "MCP settings" };
const OPTIONS = { accessField: "workspaceMcpAccess" } as const;

export default function McpBlock({ wsId }: { wsId: string }) {
  const endpoint = `/api/workspaces/${wsId}/mcp-config`;
  const credential = useCredential<McpExtra>(endpoint, LABELS, OPTIONS);

  const skills = credential.extra?.exposedSkills ?? [];
  const origin = credential.extra?.publicBaseUrl ?? (typeof window !== "undefined" ? window.location.origin : "");
  const url = `${origin}/api/workspaces/${wsId}/mcp`;

  return (
    <CredentialPanel
      title="Workspace MCP access"
      toggleLabel="Workspace MCP"
      description="Exposes every skill this workspace declares as an MCP tool to external AI clients holding the bearer key."
      enabled={credential.enabled}
      hasKey={credential.hasKey}
      plaintext={credential.plaintext}
      busy={credential.busy}
      error={credential.error}
      onToggle={credential.toggle}
      onGenerate={credential.generate}
      onRotate={credential.rotate}
      onRevoke={credential.revoke}
      onDismissPlaintext={credential.dismissPlaintext}
    >
      <div className="flex flex-col gap-2">
        <span className="text-xs font-medium text-text">Exposed tools ({skills.length})</span>
        {skills.length === 0 ? (
          <p className="m-0 text-xs text-text-3">This workspace declares no skills yet.</p>
        ) : (
          skills.map((s) => (
            <div key={s.id} className="flex flex-col min-w-0 bg-white border border-border rounded-ctrl px-3 py-2.5">
              <code className="font-mono text-[12px] font-medium leading-[1.35] text-text break-all">{s.id}</code>
              {s.description && <span className="mt-1 text-xs leading-[1.5] text-text-2">{s.description}</span>}
            </div>
          ))
        )}
      </div>

      {(credential.hasKey || credential.plaintext) && (
        <div className="flex flex-col gap-1">
          <span className="text-xs font-medium text-text">Connection URL</span>
          <code className="font-mono text-[12px] font-medium leading-[1.5] text-text bg-white px-2 py-1 rounded border border-border min-w-0 break-all">
            {url}
          </code>
        </div>
      )}
    </CredentialPanel>
  );
}
