"use client";

import { useState, useEffect } from "react";
// DEFAULT_LLM is a plain const in a type-only module (no runtime imports), so it's safe in a client
// component and keeps the picker's fallback in lockstep with the server's actual default.
import { DEFAULT_LLM as DEFAULT } from "@/lib/agent/interfaces";

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
// PATCH /api/workspaces/:id. Provider and model lists come from /api/models (the code-owned model
// catalog), so the models offered here are the ones the app maintains — to add or retire one, edit
// lib/workspace/models.ts. A model still stored on a workspace after being retired stays selectable.

export default function ModelBlock({ wsId }: { wsId: string }) {
  const [provider, setProvider] = useState<string>(DEFAULT.provider);
  const [model, setModel] = useState<string>(DEFAULT.model);
  const [effort, setEffort] = useState<string>(DEFAULT.reasoningEffort);
  const [providers, setProviders] = useState<string[]>([DEFAULT.provider]);
  const [models, setModels] = useState<string[]>([]);
  // The effort levels the selected provider accepts (they differ per provider; empty = no effort dial,
  // e.g. DeepSeek). Sourced from /api/models so the picker offers exactly what the API will accept and
  // the control is hidden when it wouldn't affect requests.
  const [efforts, setEfforts] = useState<string[]>([]);

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

  // Load the model list whenever the provider changes. When nothing is selected (a fresh provider
  // switch clears the model), default to the provider's first model.
  useEffect(() => {
    fetch(`/api/models?provider=${encodeURIComponent(provider)}`)
      .then((r) => r.json())
      .then((d: { providers?: string[]; models?: string[]; reasoningEfforts?: string[] }) => {
        if (d.providers?.length) setProviders(d.providers);
        setModels(d.models ?? []);
        const list = d.reasoningEfforts ?? [];
        setEfforts(list);
        setModel((cur) => cur || (d.models?.[0] ?? ""));
        // Keep effort valid for the newly selected provider: providers accept different levels, so if
        // the current value isn't offered here, fall back to "low" (or the quietest level offered).
        setEffort((cur) => (list.length === 0 || list.includes(cur) ? cur : list.includes("low") ? "low" : list[0]));
      })
      .catch(() => {});
  }, [provider]);

  const dirty = provider !== saved.provider || model !== saved.model || effort !== saved.effort;

  // Keep the current model selectable even if it's no longer in the catalog (e.g. a retired model
  // still stored on this workspace), so it stays selected until the user picks another.
  const modelOptions = model && !models.includes(model) ? [model, ...models] : models;

  const save = async () => {
    if (!model.trim()) return;
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
        body: JSON.stringify({ llmProvider: provider, llmModel: model.trim(), reasoningEffort: effort }),
      });
      if (res.ok) {
        setSaved({ provider, model: model.trim(), effort });
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
              {providers.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>

            <select
              style={{ width: FIELD_WIDTH.model }}
              className="input input-sm flex-none"
              value={model}
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
                value={effort}
                onChange={(e) => setEffort(e.target.value)}
              >
                {efforts.map((eff) => (
                  <option key={eff} value={eff}>
                    {eff}
                  </option>
                ))}
              </select>
            )}

            <button className="btn" disabled={saving || !model.trim()} onClick={save}>
              {saving ? "Saving…" : "Save"}
            </button>
          </>
        ) : (
          <>
            <LockedValue value={provider} width={FIELD_WIDTH.provider} />
            <LockedValue value={model} width={FIELD_WIDTH.model} />
            {efforts.length > 0 && <LockedValue value={effort} width={FIELD_WIDTH.effort} />}
            <button className="btn" onClick={() => setEditing(true)}>
              Edit
            </button>
          </>
        )}
      </div>
    </div>
  );
}
