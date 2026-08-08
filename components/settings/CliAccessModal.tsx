// Settings modal for the instance-wide CLI access token.
//
// Drives the same useCredential hook and reuses CredentialReveal like the workspace API-key and MCP
// blocks; only the chrome differs, because this is a modal rather than a card, and it also shows the
// endpoint the CLI should connect to. Enabling and generating are two steps here, exactly as they are
// for the other two channels.
"use client";

import { useCallback, useEffect, useState } from "react";
import CredentialReveal from "@/components/shared/CredentialReveal";
import { useCredential } from "@/lib/client/hooks/useCredential";

interface CliAccessModalProps {
  open: boolean;
  onClose: () => void;
}

export default function CliAccessModal({ open, onClose }: CliAccessModalProps) {
  const credential = useCredential<{ publicBaseUrl: string | null }>(
    "/api/settings/cli-access",
    { feature: "CLI access" },
    { load: open },
  );
  const [copied, setCopied] = useState(false);

  const close = useCallback(() => {
    credential.dismissPlaintext();
    onClose();
  }, [credential, onClose]);

  useEffect(() => {
    if (!open) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [open, close]);

  if (!open) return null;

  const endpoint =
    credential.extra?.publicBaseUrl ??
    (typeof window === "undefined" ? "" : window.location.origin.replace(/\/+$/, ""));

  const copyEndpoint = async () => {
    await navigator.clipboard.writeText(endpoint);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/30 px-4 pt-[12vh]"
      onMouseDown={(event) => {
        if (event.currentTarget === event.target) close();
      }}
    >
      <div
        className="w-full max-w-[520px] rounded-card border border-border bg-white p-5 shadow-md"
        role="dialog"
        aria-modal="true"
        aria-label="CLI access"
      >
        <div className="flex items-center justify-between gap-4">
          <label className="flex cursor-pointer items-center gap-2.5 text-sm font-semibold">
            <input
              type="checkbox"
              checked={credential.enabled}
              onChange={credential.toggle}
              disabled={credential.busy}
            />
            CLI access
          </label>
          <button className="iconbtn" onClick={close} aria-label="Close">
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
              <path d="M2 2l10 10M12 2L2 12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </button>
        </div>

        {credential.error && (
          <p role="alert" className="mb-0 mt-3 text-xs text-danger">
            {credential.error}
          </p>
        )}

        {credential.enabled && (
          <div className="mt-5 flex flex-col gap-4">
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
      </div>
    </div>
  );
}
