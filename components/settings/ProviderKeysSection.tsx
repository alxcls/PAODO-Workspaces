// The deployment's LLM provider API keys — one row per provider this deployment offers.
//
// Every offered provider gets a row whether or not it has a key, because a row IS the place a first
// key is entered. A provider .env has switched off appears nowhere: its key was destroyed at startup
// and the server refuses to store a new one, so offering the field would be offering a dead end.
//
// A stored value is never sent back to the browser. What a row shows is the last few characters and
// the date it was set — enough for an operator to confirm which account is being billed, useless to
// anyone reading over their shoulder.
"use client";

import { useState } from "react";
import { useProviderKeys } from "@/lib/client/hooks/useProviderKeys";

export default function ProviderKeysSection({ open }: { open: boolean }) {
  const { providers, busy, error, save, remove } = useProviderKeys(open);
  // Per provider, so typing into one row cannot be clobbered by a refresh triggered from another.
  const [drafts, setDrafts] = useState<Record<string, string>>({});

  const setDraft = (provider: string, value: string) => setDrafts((d) => ({ ...d, [provider]: value }));

  const submit = async (provider: string) => {
    const draft = drafts[provider]?.trim();
    if (!draft) return;
    // Clear the field only on success, so a rejected key is still there to correct rather than lost.
    if (await save(provider, draft)) setDraft(provider, "");
  };

  return (
    <section>
      <div>
        <span className="text-sm font-semibold">Provider API keys</span>
        <p className="mb-0 mt-1 text-xs text-text-3">
          Your own key for each model provider. A workspace set to a provider with no key here stops at the start of its
          conversation and says so.
        </p>
      </div>

      {error && (
        <p role="alert" className="mb-0 mt-3 text-xs text-danger">
          {error}
        </p>
      )}

      {providers.length === 0 && !error && (
        <p className="mb-0 mt-3 text-xs text-text-3">
          This deployment offers no providers — every one is switched off in its configuration.
        </p>
      )}

      <div className="mt-4 flex flex-col gap-4">
        {providers.map((entry) => (
          <div key={entry.provider} className="flex flex-col gap-1.5">
            <div className="flex items-baseline justify-between gap-3">
              <span className="text-xs font-medium">{entry.provider}</span>
              {entry.hasKey ? (
                <span className="font-mono text-xs text-text-3">
                  ••••{entry.hint}
                  {entry.createdAt && ` · set ${new Date(entry.createdAt).toLocaleDateString()}`}
                </span>
              ) : (
                <span className="text-xs text-text-3">No key set</span>
              )}
            </div>
            <div className="flex items-start gap-2">
              <input
                type="password"
                className="input input-sm min-w-0 flex-1"
                // Browsers offer to save anything they think is a password, and a vendor API key in a
                // personal password manager is a copy nobody is tracking.
                autoComplete="off"
                placeholder={entry.hasKey ? "Paste a new key to replace" : `${entry.provider} API key`}
                value={drafts[entry.provider] ?? ""}
                onChange={(e) => setDraft(entry.provider, e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void submit(entry.provider);
                }}
                disabled={busy === entry.provider}
              />
              <button
                className="btn btn-sm"
                onClick={() => void submit(entry.provider)}
                disabled={busy === entry.provider || !drafts[entry.provider]?.trim()}
              >
                {busy === entry.provider ? "Saving…" : "Save"}
              </button>
              {entry.hasKey && (
                <button
                  className="linkbtn text-danger"
                  onClick={() => void remove(entry.provider)}
                  disabled={busy === entry.provider}
                >
                  Remove
                </button>
              )}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
