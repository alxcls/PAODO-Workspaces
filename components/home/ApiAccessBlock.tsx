// Home page block for managing a workspace's external API access.
// Enable/disable the channel, generate a key (plaintext shown once), rotate it, revoke it.
// The lifecycle lives in useCredential and the chrome in CredentialPanel, both shared with the MCP
// block — only the endpoint, the nouns and the connection URL are specific to the API channel.
"use client";

import CredentialPanel from "@/components/shared/CredentialPanel";
import { useCredential } from "@/lib/client/hooks/useCredential";

export default function ApiAccessBlock({ wsId }: { wsId: string }) {
  const endpoint = `/api/workspaces/${wsId}/api-key`;
  const credential = useCredential<{ publicBaseUrl: string | null }>(endpoint, {
    noun: "key",
    feature: "API access",
  });

  // The agent endpoint is published on the DNS-direct public host when one is configured; otherwise
  // show the origin the user is already on rather than a URL that would not resolve for them.
  const origin = credential.extra?.publicBaseUrl ?? (typeof window !== "undefined" ? window.location.origin : "");
  const url = `${origin}/api/workspaces/${wsId}/agent`;

  return (
    <CredentialPanel
      title="Workspace API access"
      noun="key"
      toggleLabel="API access"
      description="Lets external clients start agent runs for this workspace with a dedicated bearer key."
      enabled={credential.enabled}
      hasSecret={credential.hasSecret}
      secret={credential.secret}
      busy={credential.busy}
      error={credential.error}
      onToggle={credential.toggle}
      onMint={credential.mint}
      onRevoke={credential.revoke}
      onDismissSecret={credential.dismissSecret}
    >
      {(credential.hasSecret || credential.secret) && (
        <div className="flex flex-col gap-1">
          <span className="text-xs font-medium text-text">API endpoint</span>
          <code className="font-mono text-[12px] font-medium leading-[1.5] text-text bg-white px-2 py-1 rounded border border-border min-w-0 break-all">
            {url}
          </code>
        </div>
      )}
    </CredentialPanel>
  );
}
