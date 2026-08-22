// The deployment's LLM provider API keys — one block per provider this deployment offers.
//
// Every offered provider gets a block whether or not it has a key, because a block IS the place a
// first key is entered. A provider .env has switched off appears nowhere: its key was destroyed at
// startup and the server refuses to store a new one, so offering the field would be offering a dead
// end.
//
// A stored value is never sent back to the browser. What a block shows is the last few characters and
// the date it was set — enough for an operator to confirm which account is being billed, useless to
// anyone reading over their shoulder.
//
// Laid out exactly like CliAccessSection below it: a label, one value row (a read-only code box, or
// the field when there is something to type), then link actions. The two sections are the same kind
// of thing — a credential this deployment holds — and reading as two different kinds of thing was
// the whole problem.
//
// A provider that already HAS a key shows the code box, not a field: the input only appears once
// Replace is clicked. Password fields standing open on providers that are all fine read as "something
// is missing here", and bury the one line an operator opens this for — which key is loaded, and since
// when.
"use client";

import { useState } from "react";
import { useProviderKeys, type ProviderKeyStatus } from "@/lib/client/hooks/useProviderKeys";

// Provider ids are configuration keys — lowercase because .env and the API paths are. A label is
// read by a person deciding which vendor account they are about to pay, so it spells the vendor's own
// capitalisation. Anything unlisted falls back to the id with a leading capital, which is right for
// every one-word vendor name and never worse than the bare id.
const PROVIDER_NAMES: Record<string, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  deepseek: "DeepSeek",
  moonshot: "Moonshot",
  mistral: "Mistral",
  scaleway: "Scaleway",
};

function providerLabel(provider: string): string {
  const name = PROVIDER_NAMES[provider] ?? provider.charAt(0).toUpperCase() + provider.slice(1);
  return `${name} API key`;
}

/** "Aug 15, 2026" — day-and-month order spelled out, since 15/08 and 08/15 are both readings of the same key. */
function formatSetDate(iso: string): string {
  const date = new Date(iso);
  if (isNaN(date.getTime())) return "";
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

export default function ProviderKeysSection({ open }: { open: boolean }) {
  const { providers, busy, error, save, remove } = useProviderKeys(open);
  // Per provider, so typing into one block cannot be clobbered by a refresh triggered from another.
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  // Which blocks have their field open. A keyless provider is always open — entering the first key is
  // the only thing it is for — so this only ever tracks keys being deliberately replaced.
  const [replacing, setReplacing] = useState<Record<string, boolean>>({});

  const setDraft = (provider: string, value: string) => setDrafts((d) => ({ ...d, [provider]: value }));
  const setReplacingRow = (provider: string, on: boolean) => setReplacing((r) => ({ ...r, [provider]: on }));

  const cancel = (provider: string) => {
    setDraft(provider, "");
    setReplacingRow(provider, false);
  };

  const submit = async (provider: string) => {
    const draft = drafts[provider]?.trim();
    if (!draft) return;
    // Clear the field only on success, so a rejected key is still there to correct rather than lost.
    if (await save(provider, draft)) cancel(provider);
  };

  const removeKey = async (provider: string) => {
    await remove(provider);
    // The provider becomes keyless, and a keyless provider shows its field — so drop any half-typed
    // replacement rather than leaving it in a field that now means something else.
    cancel(provider);
  };

  const renderProvider = (entry: ProviderKeyStatus) => {
    const working = busy === entry.provider;
    const editing = !entry.hasKey || replacing[entry.provider] === true;
    const draft = drafts[entry.provider] ?? "";

    return (
      <div key={entry.provider} className="flex flex-col gap-2">
        <span className="text-xs font-medium">{providerLabel(entry.provider)}</span>

        {editing ? (
          <div className="flex items-start gap-2">
            <input
              type="password"
              // The same box as the read-only value above it and as the CLI access boxes below: tinted,
              // 12px monospace, same padding and radius. Only the focus ring says it is typeable. The
              // utilities override .input's white background, 14px sans, and larger padding/radius.
              className="input min-w-0 flex-1 rounded bg-bg-tint px-2.5 py-1.5 font-mono text-xs"
              // Browsers offer to save anything they think is a password, and a vendor API key in a
              // personal password manager is a copy nobody is tracking.
              autoComplete="off"
              placeholder={entry.hasKey ? "Paste the replacement key" : "Paste your key"}
              value={draft}
              autoFocus={entry.hasKey}
              onChange={(e) => setDraft(entry.provider, e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void submit(entry.provider);
                if (e.key === "Escape" && entry.hasKey) cancel(entry.provider);
              }}
              disabled={working}
            />
            {/* h-[30px] is the box's own height — 16px line + 12px padding + 2px border — so the button
                ends level with it. btn-sm's 26px is sized for the taller .input it usually sits beside. */}
            <button
              className="btn btn-sm h-[30px]"
              onClick={() => void submit(entry.provider)}
              disabled={working || !draft.trim()}
            >
              {working ? "Saving…" : "Save"}
            </button>
          </div>
        ) : (
          <code className="rounded border border-border bg-bg-tint px-2.5 py-1.5 font-mono text-xs text-text-3">
            ••••{entry.hint}
            {entry.createdAt && ` · set ${formatSetDate(entry.createdAt)}`}
          </code>
        )}

        {entry.hasKey && (
          // -ml-1.5 cancels the link's own padding so its text starts on the box's left edge above it,
          // rather than a few pixels inside it.
          <div className="-ml-1.5 flex items-center gap-2">
            {editing ? (
              <button className="linkbtn self-start" onClick={() => cancel(entry.provider)} disabled={working}>
                Cancel
              </button>
            ) : (
              <button
                className="linkbtn self-start"
                onClick={() => setReplacingRow(entry.provider, true)}
                disabled={working}
              >
                Replace key
              </button>
            )}
            <button className="linkbtn text-danger" onClick={() => void removeKey(entry.provider)} disabled={working}>
              {working && !editing ? "Working…" : "Remove"}
            </button>
          </div>
        )}
      </div>
    );
  };

  return (
    <section>
      <span className="text-sm font-semibold">Provider API keys</span>
      <p className="mb-0 mt-1.5 text-xs text-text-3">Register your own keys for each model provider.</p>

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

      <div className="mt-5 flex flex-col gap-6">{providers.map(renderProvider)}</div>
    </section>
  );
}
