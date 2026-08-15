"use client";

import { useState, useEffect } from "react";
import { THINKING_OFF_EFFORT, type ReasoningEffort } from "@/lib/models/llmSelection";
import { defaultEffortFor } from "@/lib/models/selection";
// The GET /api/models payload shape, imported from the module that SERVES it rather than redeclared
// here. `import type` is erased at compile time, so this pulls none of that module's runtime graph
// (which reaches the LLM SDKs) into the client bundle. Redeclaring it drifted once already: the
// server made `thinking` required while this copy still had it optional.
import type { ModelCatalog } from "@/lib/operations/models/catalog";
import { confirmedValues } from "@/lib/client/workspaceReceipt";

// Compact fixed widths so the row of controls stays roughly half the block width. Applied inline
// because the `.input` base class is `w-full`, which otherwise stretches each field to fill the row.
const FIELD_WIDTH = { provider: 128, model: 168, effort: 100 };

// A committed value shown when not editing: a greyed, caret-less read-only field so it clearly
// reads as a set value rather than an interactive dropdown. Keep this component at module scope so
// React preserves its identity across ModelBlock renders.
function LockedValue({ value, width }: { value: string; width: number }) {
  return (
    <div
      style={{ width }}
      className="input input-sm flex-none flex items-center bg-bg-tint text-text-2 cursor-default select-none overflow-hidden text-ellipsis whitespace-nowrap"
    >
      {value}
    </div>
  );
}

// Per-workspace LLM picker: provider + model + reasoning effort, persisted on the workspace via
// PATCH /api/workspaces/:id. The complete provider → models/efforts hierarchy comes from one
// /api/models read, so the UI and programmatic callers consume the same code-owned catalog without a
// request per provider change. The provider list is narrowed to those .env makes available: an API key
// is set and <PROVIDER>_AVAILABLE is not false.

// Empty until the workspace read lands, rather than seeded with a guess at the default: the default is
// the first provider .env makes available, which only the server knows. A hardcoded seed here would
// flash a provider this deployment may have switched off, and would stick if the read failed.
export default function ModelBlock({ wsId, catalogVersion = 0 }: { wsId: string; catalogVersion?: number }) {
  const [provider, setProvider] = useState<string>("");
  const [model, setModel] = useState<string>("");
  const [effort, setEffort] = useState<string>("");
  const [catalog, setCatalog] = useState<ModelCatalog>({});
  const [catalogLoaded, setCatalogLoaded] = useState(false);

  const [saved, setSaved] = useState<{ provider: string; model: string; effort: string }>({
    provider: "",
    model: "",
    effort: "",
  });
  const [saving, setSaving] = useState(false);
  // Committed view by default: dropdowns are locked to the saved selection until the user clicks Edit.
  const [editing, setEditing] = useState(false);

  // Load the workspace's current selection. The server already applies the defaults for a workspace
  // that never picked, so what arrives is the complete selection — reasoningEffort excepted, which is
  // absent for a provider with no effort dial.
  useEffect(() => {
    fetch(`/api/workspaces/${wsId}`)
      .then((r) => r.json())
      .then((d: { llmProvider?: string; llmModel?: string; reasoningEffort?: string }) => {
        const p = d.llmProvider ?? "";
        const m = d.llmModel ?? "";
        const e = d.reasoningEffort ?? "";
        setProvider(p);
        setModel(m);
        setEffort(e);
        setSaved({ provider: p, model: m, effort: e });
      })
      .catch(() => {});
  }, [wsId]);

  // Provider ids own their models and accepted effort levels, so changing a dropdown stays a local
  // lookup rather than another network request. The one thing that does invalidate the catalog is a
  // provider key being added or removed in Settings, since `hasKey` drives the warning below —
  // `catalogVersion` is the parent's signal that this happened, and re-reading is how the warning
  // clears without a page reload.
  useEffect(() => {
    let active = true;
    fetch("/api/models")
      .then((r) => r.json())
      .then((d: { providers?: ModelCatalog }) => {
        if (active) {
          setCatalog(d.providers ?? {});
          setCatalogLoaded(true);
        }
      })
      .catch(() => {
        if (active) setCatalogLoaded(true);
      });
    return () => {
      active = false;
    };
  }, [catalogVersion]);

  const providerCatalog = catalog[provider];
  const providers = Object.keys(catalog);
  const models = providerCatalog?.models ?? [];
  // Empty means the selected provider has no effort dial (for example DeepSeek), so the control is
  // absent rather than presenting a setting the agent never sends.
  const efforts = providerCatalog?.reasoningEfforts ?? [];
  // Never replace a stored retired id just for display. It stays visible until the user explicitly
  // picks a current model, which also prevents the UI and runtime from claiming different models.
  const selectedModel = model;
  const modelUnavailable =
    catalogLoaded && Boolean(model) && (!providerCatalog || !providerCatalog.models.includes(model));
  const validModel = Boolean(providerCatalog?.models.includes(selectedModel));
  const selectedEffort =
    providerCatalog &&
    providerCatalog.reasoningEfforts.length > 0 &&
    !providerCatalog.reasoningEfforts.includes(effort as ReasoningEffort)
      ? defaultEffortFor(providerCatalog)
      : effort;

  // The effort vocabulary already describes the control completely: empty means no thinking dial,
  // `none` means it can be switched off, and a non-empty list without `none` means it is always on.
  const hasThinking = efforts.length > 0;
  const thinkingAlways = hasThinking && !efforts.includes(THINKING_OFF_EFFORT);
  const thinkingOn = thinkingAlways || selectedEffort !== THINKING_OFF_EFFORT;
  // The levels worth choosing BETWEEN once thinking is on. "none" is excluded because turning
  // thinking off is the checkbox's job, and offering it in both places lets the two disagree.
  const levels = efforts.filter((eff) => eff !== THINKING_OFF_EFFORT);
  // One level is not a choice: the checkbox already controls on/off, so a one-option dropdown beside
  // it would add no information.
  const showEffort = thinkingOn && levels.length > 1;

  const dirty = provider !== saved.provider || selectedModel !== saved.model || selectedEffort !== saved.effort;

  const modelOptions = models;

  // Belt and braces for a stale tab. The server no longer keeps a workspace on a withdrawn provider
  // (startup clears those selections, and a PATCH naming one is refused), so this only fires when the
  // deployment switched a provider off after this page loaded — and even then the row shows the value
  // the workspace really holds rather than silently swapping it for the first catalog entry.
  const providerOptions = provider && !providers.includes(provider) ? [provider, ...providers] : providers;

  // Whether the selected provider can actually authenticate. Read from the catalog this component
  // already fetched, so the warning costs no extra request.
  //
  // A run stops with this same fact at conversation start, which is the backstop — but finding out
  // there is no key only after sending a message, in the transcript, is a worse place to learn it
  // than right here where the provider was chosen. A provider not in the catalog at all (a stored
  // selection whose provider was since withdrawn) is left alone: it has its own message on the run,
  // and "add a key" would be the wrong advice for it.
  const missingKey = Boolean(provider) && providerCatalog !== undefined && !providerCatalog.hasKey;

  const save = async () => {
    if (!validModel) return;
    // Nothing changed — just leave edit mode without a needless PATCH.
    if (!dirty) {
      setEditing(false);
      return;
    }
    setSaving(true);
    try {
      const res = await fetch(`/api/workspaces/${wsId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          llmProvider: provider,
          llmModel: selectedModel.trim(),
          ...(efforts.length > 0 ? { reasoningEffort: selectedEffort } : {}),
        }),
      });
      if (res.ok) {
        const confirmed = await confirmedValues(res);
        const savedProvider = confirmed.llmProvider ?? provider;
        const savedModel = confirmed.llmModel ?? selectedModel.trim();
        const savedEffort = confirmed.reasoningEffort ?? (efforts.length > 0 ? selectedEffort : "");
        setProvider(savedProvider);
        setModel(savedModel);
        setEffort(savedEffort);
        setSaved({ provider: savedProvider, model: savedModel, effort: savedEffort });
        setEditing(false);
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex flex-col gap-3 mt-4 border border-border rounded-card p-[14px_16px] bg-bg-tint">
      <div>
        <span className="text-ms font-semibold text-text">Model</span>
        <span className="text-xs text-text-3 ml-2">Choose provider and model for this workspace</span>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {editing ? (
          <>
            <select
              style={{ width: FIELD_WIDTH.provider }}
              className="input input-sm flex-none"
              value={provider}
              onChange={(e) => {
                setProvider(e.target.value);
                setModel("");
                setEffort("");
              }}
            >
              {providerOptions.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>

            <select
              style={{ width: FIELD_WIDTH.model }}
              className="input input-sm flex-none"
              value={selectedModel}
              onChange={(e) => setModel(e.target.value)}
            >
              {!selectedModel && (
                <option value="" disabled>
                  Choose a model…
                </option>
              )}
              {modelUnavailable && (
                <option value={selectedModel} disabled>
                  {selectedModel} (unavailable — choose another)
                </option>
              )}
              {modelOptions.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>

            {showEffort && (
              <select
                style={{ width: FIELD_WIDTH.effort }}
                className="input input-sm flex-none"
                value={selectedEffort}
                onChange={(e) => setEffort(e.target.value)}
              >
                {levels.map((eff) => (
                  <option key={eff} value={eff}>
                    {eff}
                  </option>
                ))}
              </select>
            )}

            {hasThinking && (
              <label
                className="flex-none flex items-center gap-1.5 text-ms text-text-2 select-none"
                title={
                  thinkingAlways
                    ? "This model always thinks — it offers no way to switch that off."
                    : "Let the model think before it answers."
                }
              >
                <input
                  type="checkbox"
                  // An "always" model is checked and disabled rather than hidden: "on" is the truth,
                  // and presenting it as a choice the user could change would be a lie the API
                  // enforces — those models reject the request outright if told otherwise.
                  checked={thinkingOn}
                  disabled={thinkingAlways}
                  onChange={(e) =>
                    setEffort(
                      e.target.checked && providerCatalog ? defaultEffortFor(providerCatalog) : THINKING_OFF_EFFORT,
                    )
                  }
                />
                Thinking
              </label>
            )}

            <button className="btn" disabled={saving || !validModel} onClick={save}>
              {saving ? "Saving…" : "Save"}
            </button>
          </>
        ) : (
          <>
            <LockedValue value={provider} width={FIELD_WIDTH.provider} />
            <LockedValue value={selectedModel} width={FIELD_WIDTH.model} />
            {showEffort && <LockedValue value={selectedEffort} width={FIELD_WIDTH.effort} />}
            {hasThinking && (
              <label className="flex-none flex items-center gap-1.5 text-ms text-text-3 select-none cursor-default">
                <input type="checkbox" checked={thinkingOn} disabled readOnly />
                Thinking
              </label>
            )}
            <button className="btn" onClick={() => setEditing(true)}>
              Edit
            </button>
          </>
        )}
      </div>

      {missingKey && (
        <p role="alert" className="mb-0 text-xs text-danger">
          No API key set for {provider} — add one in Settings, or this workspace cannot run.
        </p>
      )}
      {modelUnavailable && (
        <p role="alert" className="mb-0 text-xs text-danger">
          {model} is no longer available for {provider}. Click Edit and choose a current model before running this
          workspace.
        </p>
      )}
    </div>
  );
}
