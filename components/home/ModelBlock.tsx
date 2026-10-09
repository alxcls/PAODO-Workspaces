"use client";

import { useState, useEffect } from "react";
import type { AsyncResource } from "@/lib/client/hooks/useAsyncResource";
import type { WorkspaceDetails } from "@/lib/client/hooks/useWorkspaceDetails";
import { AsyncState } from "@/components/shared/AsyncState";
import { Switch } from "@/components/shared/Switch";
import { THINKING_OFF_EFFORT, type ReasoningEffort } from "@/lib/models/llmSelection";
import { defaultEffortFor, effortsForModel } from "@/lib/models/selection";
// The GET /api/models payload shape, from the module that serves it so the two cannot drift.
// `import type` is erased at compile time, so none of its runtime graph reaches the client bundle.
import type { ModelCatalog } from "@/lib/operations/models/catalog";
import { confirmedValues } from "@/lib/client/workspaceReceipt";

// Compact fixed widths so the row of controls stays roughly half the block width. Applied inline
// because the `.input` base class is `w-full`, which otherwise stretches each field to fill the row.
const FIELD_WIDTH = { provider: 128, model: 168, effort: 100 };

// A committed value shown when not editing: a greyed, caret-less field that reads as a set value.
// Kept at module scope so React preserves its identity across ModelBlock renders.
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

// Per-workspace LLM picker (provider, model, reasoning effort), saved by PATCH /api/workspaces/:id.
// One /api/models read supplies the whole catalog, already narrowed to providers .env makes available.

// Empty until the workspace read lands: only the server knows the default provider, and a hardcoded
// seed would flash one this deployment may have switched off, then stick if the read failed.
export default function ModelBlock({
  wsId,
  workspace,
  catalogVersion = 0,
}: {
  wsId: string;
  workspace: AsyncResource<WorkspaceDetails>;
  catalogVersion?: number;
}) {
  return (
    <div className="flex flex-col gap-3 mt-4 border border-border rounded-card p-[14px_16px] bg-bg-tint">
      <div>
        <span className="text-ms font-semibold text-text">Model</span>
        <span className="text-xs text-text-3 ml-2">Choose provider and model for this workspace</span>
      </div>
      {workspace.data ? (
        <ModelForm key={wsId} wsId={wsId} initial={workspace.data} catalogVersion={catalogVersion} />
      ) : (
        <AsyncState
          loading={workspace.loading}
          error={workspace.error}
          onRetry={workspace.reload}
          errorLabel="Couldn’t load the model selection."
        />
      )}
    </div>
  );
}

function ModelForm({
  wsId,
  initial,
  catalogVersion,
}: {
  wsId: string;
  initial: WorkspaceDetails;
  catalogVersion: number;
}) {
  type Selection = { provider: string; model: string; effort: string };
  const [confirmed, setConfirmed] = useState<{ source: WorkspaceDetails; value: Selection } | null>(null);
  const saved =
    confirmed?.source === initial
      ? confirmed.value
      : {
          provider: initial.llmProvider ?? "",
          model: initial.llmModel ?? "",
          effort: initial.reasoningEffort ?? "",
        };
  // An untouched form follows shared reads; an edit remains local until explicitly saved.
  const [draft, setDraft] = useState<Selection | null>(null);
  const { provider, model, effort } = draft ?? saved;
  const editing = draft !== null;
  const setProvider = (provider: string) => setDraft((current) => ({ ...(current ?? saved), provider }));
  const setModel = (model: string) => setDraft((current) => ({ ...(current ?? saved), model }));
  const setEffort = (effort: string) => setDraft((current) => ({ ...(current ?? saved), effort }));
  const [catalog, setCatalog] = useState<ModelCatalog>({});
  const [catalogLoaded, setCatalogLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  // Changing a dropdown is a local catalog lookup, not a request. `catalogVersion` changes when a
  // provider key is added or removed in Settings, and the re-read is what clears the key warning.
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
  // Never replace a stored retired id just for display. It stays visible until the user explicitly
  // picks a current model, which also prevents the UI and runtime from claiming different models.
  const selectedModel = model;
  // Empty means no effort dial for this model, so the control is absent rather than presenting a
  // setting the agent never sends. The catalog narrows per model where a vendor does (Scaleway).
  const efforts = providerCatalog ? effortsForModel(providerCatalog, selectedModel) : [];
  const modelUnavailable =
    catalogLoaded && Boolean(model) && (!providerCatalog || !providerCatalog.models.includes(model));
  const validModel = Boolean(providerCatalog?.models.includes(selectedModel));
  const selectedEffort =
    providerCatalog && efforts.length > 0 && !efforts.includes(effort as ReasoningEffort)
      ? defaultEffortFor(providerCatalog, selectedModel)
      : effort;

  // The effort vocabulary already describes the control completely: empty means no thinking dial,
  // `none` means it can be switched off, and a non-empty list without `none` means it is always on.
  const hasThinking = efforts.length > 0;
  const thinkingAlways = hasThinking && !efforts.includes(THINKING_OFF_EFFORT);
  const thinkingOn = thinkingAlways || selectedEffort !== THINKING_OFF_EFFORT;
  // The levels worth choosing BETWEEN once thinking is on. "none" is excluded because turning
  // thinking off is the switch's job, and offering it in both places lets the two disagree.
  const levels = efforts.filter((eff) => eff !== THINKING_OFF_EFFORT);
  // One level is not a choice: the switch already controls on/off, so a one-option dropdown beside
  // it would add no information.
  const showEffort = thinkingOn && levels.length > 1;

  const dirty = provider !== saved.provider || selectedModel !== saved.model || selectedEffort !== saved.effort;

  const modelOptions = models;

  // Stale-tab guard: if the provider was switched off after this page loaded, keep showing the
  // value the workspace really holds rather than silently swapping in the first catalog entry.
  const providerOptions = provider && !providers.includes(provider) ? [provider, ...providers] : providers;

  // Whether the selected provider can authenticate, so a missing key is flagged here rather than
  // mid-run. A provider absent from the catalog is left alone: the run has its own message for it.
  const missingKey = Boolean(provider) && providerCatalog !== undefined && !providerCatalog.hasKey;

  const save = async () => {
    if (!validModel) return;
    // Nothing changed — just leave edit mode without a needless PATCH.
    if (!dirty) {
      setDraft(null);
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
        setConfirmed({ source: initial, value: { provider: savedProvider, model: savedModel, effort: savedEffort } });
        setDraft(null);
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
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

            {hasThinking && (
              // An "always" model is shown on and disabled rather than hidden: "on" is the truth,
              // and those models reject the request outright if told otherwise.
              <Switch
                label="Thinking"
                className="px-1"
                checked={thinkingOn}
                disabled={thinkingAlways}
                title={
                  thinkingAlways
                    ? "This model always thinks — it offers no way to switch that off."
                    : "Let the model think before it answers."
                }
                onChange={(on) =>
                  setEffort(
                    on && providerCatalog ? defaultEffortFor(providerCatalog, selectedModel) : THINKING_OFF_EFFORT,
                  )
                }
              />
            )}

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

            <button className="btn" disabled={saving || !validModel} onClick={save}>
              {saving ? "Saving…" : "Save"}
            </button>
          </>
        ) : (
          <>
            <LockedValue value={provider} width={FIELD_WIDTH.provider} />
            <LockedValue value={selectedModel} width={FIELD_WIDTH.model} />
            {hasThinking && (
              <Switch label="Thinking" className="px-1" checked={thinkingOn} disabled onChange={() => {}} />
            )}
            {showEffort && <LockedValue value={selectedEffort} width={FIELD_WIDTH.effort} />}
            <button className="btn" onClick={() => setDraft(saved)}>
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
    </>
  );
}
