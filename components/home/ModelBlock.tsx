"use client";

import { useState, useEffect } from "react";
// DEFAULT_LLM is a plain const in a type-only module (no runtime imports), so it's safe in a client
// component and keeps the picker's fallback in lockstep with the server's actual default.
import { DEFAULT_LLM as DEFAULT, type ReasoningEffort } from "@/lib/agent/interfaces";
// The model/effort defaulting rules, shared with the server-side update path so the picker and a
// partial PATCH resolve a gap the same way.
import { defaultEffortFor, defaultModelFor } from "@/lib/workspace/modelSelection";
import { confirmedValues } from "@/lib/client/workspaceReceipt";

// Compact fixed widths so the row of controls stays roughly half the block width. Applied inline
// because the `.input` base class is `w-full`, which otherwise stretches each field to fill the row.
const FIELD_WIDTH = { provider: 128, model: 168, effort: 100 };

interface ProviderCatalog {
  models: string[];
  reasoningEfforts: ReasoningEffort[];
}

type ModelCatalog = Record<string, ProviderCatalog>;

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
// request per provider change. The provider list is narrowed to those with an API key set in .env.

export default function ModelBlock({ wsId }: { wsId: string }) {
  const [provider, setProvider] = useState<string>(DEFAULT.provider);
  const [model, setModel] = useState<string>(DEFAULT.model);
  const [effort, setEffort] = useState<string>(DEFAULT.reasoningEffort);
  const [catalog, setCatalog] = useState<ModelCatalog>({});

  const [saved, setSaved] = useState<{ provider: string; model: string; effort: string }>({
    provider: DEFAULT.provider,
    model: DEFAULT.model,
    effort: DEFAULT.reasoningEffort,
  });
  const [saving, setSaving] = useState(false);
  // Committed view by default: dropdowns are locked to the saved selection until the user clicks Edit.
  const [editing, setEditing] = useState(false);

  // Load the workspace's current selection (falling back to the defaults when unset).
  useEffect(() => {
    fetch(`/api/workspaces/${wsId}`)
      .then((r) => r.json())
      .then((d: { llmProvider?: string; llmModel?: string; reasoningEffort?: string }) => {
        const p = d.llmProvider ?? DEFAULT.provider;
        const m = d.llmModel ?? DEFAULT.model;
        const e = d.reasoningEffort ?? DEFAULT.reasoningEffort;
        setProvider(p);
        setModel(m);
        setEffort(e);
        setSaved({ provider: p, model: m, effort: e });
      })
      .catch(() => {});
  }, [wsId]);

  // One catalog read for the component's lifetime. Provider ids own their models and accepted effort
  // levels, so changing the dropdown is a local lookup rather than another network request.
  useEffect(() => {
    fetch("/api/models")
      .then((r) => r.json())
      .then((d: { providers?: ModelCatalog }) => setCatalog(d.providers ?? {}))
      .catch(() => {});
  }, []);

  const providerCatalog = catalog[provider];
  const providers = Object.keys(catalog);
  const models = providerCatalog?.models ?? (model ? [model] : []);
  // Empty means the selected provider has no effort dial (for example DeepSeek), so the control is
  // absent rather than presenting a setting the agent never sends.
  const efforts = providerCatalog?.reasoningEfforts ?? [];
  // Defaults are derived rather than written from an effect. A provider switch keeps compatible
  // values and otherwise resolves exactly as workspace PATCH does; a provider absent from the usable
  // catalog retains its stored selection so an old workspace never renders blank.
  const selectedModel =
    providerCatalog && !providerCatalog.models.includes(model) ? defaultModelFor(providerCatalog) : model;
  const selectedEffort =
    providerCatalog &&
    providerCatalog.reasoningEfforts.length > 0 &&
    !providerCatalog.reasoningEfforts.includes(effort as ReasoningEffort)
      ? defaultEffortFor(providerCatalog)
      : effort;

  const dirty = provider !== saved.provider || selectedModel !== saved.model || selectedEffort !== saved.effort;

  // PATCH refuses a model the provider does not serve, so configured providers expose their catalog
  // and swap a retired selection to the default before save.
  const modelOptions = models;

  // A workspace selected before its provider key was removed remains visible even though it is no
  // longer offered for new selections.
  const providerOptions = provider && !providers.includes(provider) ? [provider, ...providers] : providers;

  const save = async () => {
    if (!selectedModel.trim()) return;
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
        const savedEffort = confirmed.reasoningEffort ?? selectedEffort;
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
              {modelOptions.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>

            {efforts.length > 0 && (
              <select
                style={{ width: FIELD_WIDTH.effort }}
                className="input input-sm flex-none"
                value={selectedEffort}
                onChange={(e) => setEffort(e.target.value)}
              >
                {efforts.map((eff) => (
                  <option key={eff} value={eff}>
                    {eff}
                  </option>
                ))}
              </select>
            )}

            <button className="btn" disabled={saving || !selectedModel.trim()} onClick={save}>
              {saving ? "Saving…" : "Save"}
            </button>
          </>
        ) : (
          <>
            <LockedValue value={provider} width={FIELD_WIDTH.provider} />
            <LockedValue value={selectedModel} width={FIELD_WIDTH.model} />
            {efforts.length > 0 && <LockedValue value={selectedEffort} width={FIELD_WIDTH.effort} />}
            <button className="btn" onClick={() => setEditing(true)}>
              Edit
            </button>
          </>
        )}
      </div>
    </div>
  );
}
