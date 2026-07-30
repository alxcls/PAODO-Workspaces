// Card chrome for a workspace access channel: title, status, on/off switch, then the generate /
// rotate / revoke controls and the reveal-once secret. Shared by the API-access and MCP home blocks,
// which differed only in their nouns and in the extra content MCP puts in the middle.
//
// The CLI access modal deliberately does NOT use this — it is a modal, not a card — but it drives the
// same useCredential hook and reuses CredentialSecret, which is where the real duplication was.
"use client";

import type { ReactNode } from "react";
import CredentialSecret from "./CredentialSecret";

interface CredentialPanelProps {
  title: string;
  /** What the secret is called in this channel's UI, e.g. "key" or "secret". */
  noun: string;
  /** One line explaining what opening the channel does. Shown only while enabled. */
  description: string;
  /** Label for the toggle's accessible name, e.g. "API access". */
  toggleLabel: string;
  enabled: boolean;
  hasSecret: boolean;
  secret: string | null;
  busy: boolean;
  error: string | null;
  onToggle: () => void;
  onMint: () => void;
  onRevoke: () => void;
  onDismissSecret: () => void;
  /** Channel-specific content rendered while enabled, above the controls (MCP's skill selection). */
  children?: ReactNode;
}

export default function CredentialPanel({
  title,
  noun,
  description,
  toggleLabel,
  enabled,
  hasSecret,
  secret,
  busy,
  error,
  onToggle,
  onMint,
  onRevoke,
  onDismissSecret,
  children,
}: CredentialPanelProps) {
  return (
    <div className="flex flex-col gap-4 mt-4 border border-border rounded-card p-[16px_18px] bg-bg-tint">
      <div className="flex items-center justify-between">
        <div className="min-w-0">
          <span className="text-ms font-semibold text-text">{title}</span>
          <span className={`text-xs ml-2 ${enabled && hasSecret ? "text-select" : "text-text-3"}`}>
            {enabled ? (hasSecret ? `${capitalize(noun)} active` : `${capitalize(noun)} required`) : "Disabled"}
          </span>
        </div>
        <button
          className={`relative w-9 h-5 rounded-[10px] border-0 cursor-pointer transition-colors duration-200 p-0 flex-shrink-0 ${enabled ? "bg-primary" : "bg-border"}`}
          onClick={onToggle}
          disabled={busy}
          aria-label={enabled ? `Disable ${toggleLabel}` : `Enable ${toggleLabel}`}
        >
          <span
            className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white transition-transform duration-200 block ${enabled ? "translate-x-4" : ""}`}
          />
        </button>
      </div>

      {error && (
        <p className="m-0 text-xs text-danger" role="alert">
          {error}
        </p>
      )}

      {enabled && (
        <>
          <p className="m-0 text-xs text-text-3">{description}</p>

          {children}

          {!hasSecret && !secret && (
            <button className="btn btn-sm self-start" onClick={onMint} disabled={busy}>
              {busy ? "Generating…" : `Generate ${noun}`}
            </button>
          )}

          {hasSecret && !secret && (
            <div className="flex items-center gap-2.5">
              <button className="linkbtn" onClick={onMint} disabled={busy}>
                Rotate
              </button>
              <button className="linkbtn text-danger" onClick={onRevoke} disabled={busy}>
                Revoke
              </button>
            </div>
          )}

          {secret && <CredentialSecret secret={secret} noun={noun} onDismiss={onDismissSecret} />}
        </>
      )}
    </div>
  );
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
