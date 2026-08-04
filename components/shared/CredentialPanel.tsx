// Card chrome for a workspace access channel: title, status, on/off switch, then the generate /
// rotate / revoke controls and the reveal-once key. Shared by the API-access and MCP home blocks,
// which differ only in the extra content MCP puts in the middle.
//
// Every channel calls its credential a "key", so this file says so in plain strings. It used to take
// a `noun` prop, which let one channel say "secret" while another said "key" for the same thing —
// and on the home page "secret" also means a third-party env-var secret, a different primitive
// entirely. One word per concept is the point; a prop is how it drifted.
//
// The card shows two independent axes, and the controls for each are gated only by their own:
//   - the switch opens or closes the channel;
//   - `hasKey` decides whether you see Generate, or Rotate and Revoke.
// So a key can be issued before the channel opens, and a leaked one destroyed after it closes —
// neither action has to move the switch to reach the other axis.
//
// The CLI access modal deliberately does NOT use this — it is a modal, not a card — but it drives the
// same useCredential hook and reuses CredentialReveal, which is where the real duplication was.
"use client";

import type { ReactNode } from "react";
import CredentialReveal from "./CredentialReveal";

interface CredentialPanelProps {
  title: string;
  /** One line explaining what opening the channel does. Shown only while enabled. */
  description: string;
  /** Label for the toggle's accessible name, e.g. "API access". */
  toggleLabel: string;
  enabled: boolean;
  hasKey: boolean;
  /** The reveal-once plaintext, present only between minting it and dismissing it. */
  plaintext: string | null;
  busy: boolean;
  error: string | null;
  onToggle: () => void;
  /** Issues the channel's first credential. Offered only while it has none. */
  onGenerate: () => void;
  /** Replaces the existing credential. Offered only while it has one. */
  onRotate: () => void;
  onRevoke: () => void;
  onDismissPlaintext: () => void;
  /** Channel-specific content rendered while enabled, above the controls (MCP's tools and URL). */
  children?: ReactNode;
}

export default function CredentialPanel({
  title,
  description,
  toggleLabel,
  enabled,
  hasKey,
  plaintext,
  busy,
  error,
  onToggle,
  onGenerate,
  onRotate,
  onRevoke,
  onDismissPlaintext,
  children,
}: CredentialPanelProps) {
  return (
    <div className="flex flex-col gap-4 mt-4 border border-border rounded-card p-[16px_18px] bg-bg-tint">
      <div className="flex items-center justify-between">
        <div className="min-w-0">
          <span className="text-ms font-semibold text-text">{title}</span>
          <span className={`text-xs ml-2 ${enabled && hasKey ? "text-select" : "text-text-3"}`}>
            {statusLabel(enabled, hasKey)}
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

      {/* Describes what an open channel does, and MCP's tools and URL. Both are true only of a live
          channel, so unlike the credential controls they stay behind the switch. */}
      {enabled && (
        <>
          <p className="m-0 text-xs text-text-3">{description}</p>
          {children}
        </>
      )}

      {!hasKey && !plaintext && (
        <button className="btn btn-sm self-start" onClick={onGenerate} disabled={busy}>
          {busy ? "Generating…" : "Generate key"}
        </button>
      )}

      {hasKey && !plaintext && (
        <div className="flex items-center gap-2.5">
          <button className="linkbtn" onClick={onRotate} disabled={busy}>
            Rotate
          </button>
          <button className="linkbtn text-danger" onClick={onRevoke} disabled={busy}>
            Revoke
          </button>
        </div>
      )}

      {plaintext && <CredentialReveal plaintext={plaintext} onDismiss={onDismissPlaintext} />}
    </div>
  );
}

/**
 * Names both axes at once. A closed channel that still holds a key says so rather than reading as a
 * bare "Disabled", which would suggest the key was gone and leave no reason to look for Revoke.
 */
function statusLabel(enabled: boolean, hasKey: boolean): string {
  if (!enabled) return hasKey ? "Disabled · key exists" : "Disabled";
  return hasKey ? "Key active" : "Key required";
}
