// The instance-wide CLI access token, as one section of the settings modal.
//
// Drives the same useCredential hook and reuses CredentialReveal like the workspace API-key and MCP
// blocks. Enabling and generating are two steps here, exactly as they are for the other two channels.
//
// The modal chrome that used to live in this file is now SettingsModal.tsx, because the modal holds
// more than one thing: this section and the provider API keys. Everything below is unchanged from
// when it was CliAccessModal — only the surrounding dialog moved out.
"use client";

import { useEffect, useState } from "react";
import CredentialReveal from "@/components/shared/CredentialReveal";
import { useCredential } from "@/lib/client/hooks/useCredential";

export default function CliAccessSection({ open }: { open: boolean }) {
  const credential = useCredential<{ publicBaseUrl: string | null }>(
    "/api/settings/cli-access",
    { feature: "CLI access" },
    { load: open },
  );
  const [copied, setCopied] = useState(false);

  // The one-time plaintext must not survive the modal closing — reopening it would otherwise show a
  // key the user already dismissed, in a place they did not ask for it.
  const { dismissPlaintext } = credential;
  useEffect(() => {
    if (!open) dismissPlaintext();
  }, [open, dismissPlaintext]);

  const endpoint =
    credential.extra?.publicBaseUrl ??
    (typeof window === "undefined" ? "" : window.location.origin.replace(/\/+$/, ""));

  const copyEndpoint = async () => {
    await navigator.clipboard.writeText(endpoint);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 2000);
  };

  return (
    <section>
      <label className="flex cursor-pointer items-center gap-2.5 text-sm font-semibold">
        <input type="checkbox" checked={credential.enabled} onChange={credential.toggle} disabled={credential.busy} />
        CLI access
      </label>

      {credential.error && (
        <p role="alert" className="mb-0 mt-3 text-xs text-danger">
          {credential.error}
        </p>
      )}

      {credential.enabled && (
        <div className="mt-4 flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <span className="text-xs font-medium">Endpoint</span>
            <div className="flex items-start gap-2">
              <code className="min-w-0 flex-1 break-all rounded border border-border bg-bg-tint px-2 py-1 font-mono text-xs">
                {endpoint}
              </code>
              <button className="btn btn-sm" onClick={copyEndpoint}>
                {copied ? "Copied!" : "Copy"}
              </button>
            </div>
          </div>

          <div className="flex flex-col gap-1.5">
            <span className="text-xs font-medium">Key</span>
            {credential.plaintext ? (
              <CredentialReveal plaintext={credential.plaintext} />
            ) : (
              <code className="rounded border border-border bg-bg-tint px-2 py-1 font-mono text-xs text-text-3">
                {credential.hasKey ? "••••••••••••••••••••••••" : "No key"}
              </code>
            )}
          </div>

          <div className="flex items-center gap-2.5">
            <button
              className="linkbtn self-start"
              onClick={credential.hasKey ? credential.rotate : credential.generate}
              disabled={credential.busy}
            >
              {credential.busy ? "Working…" : credential.hasKey ? "Rotate key" : "Generate key"}
            </button>
            {credential.hasKey && (
              <button className="linkbtn text-danger" onClick={credential.revoke} disabled={credential.busy}>
                Revoke
              </button>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
