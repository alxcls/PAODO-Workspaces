"use client";

import { useState, useEffect } from "react";

export default function AgentLoopBlock({ wsId }: { wsId: string }) {
  const [value, setValue] = useState(30);
  const [draft, setDraft] = useState("30");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    fetch(`/api/workspaces/${wsId}`)
      .then((r) => r.json())
      .then((d: { maxIterations?: number }) => {
        const n = d.maxIterations ?? 30;
        setValue(n);
        setDraft(String(n));
      })
      .catch(() => {});
  }, [wsId]);

  const save = async () => {
    const n = Math.max(1, Math.floor(Number(draft)));
    if (!isFinite(n)) return;
    setSaving(true);
    try {
      await fetch(`/api/workspaces/${wsId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ maxIterations: n }),
      });
      setValue(n);
      setDraft(String(n));
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } finally {
      setSaving(false);
    }
  };

  const dirty = Math.max(1, Math.floor(Number(draft))) !== value;

  return (
    <div className="flex flex-col gap-3 mt-4 border border-border rounded-card p-[14px_16px] bg-bg-tint">
      <div>
        <span className="text-ms font-semibold text-text">Agent Loop</span>
        <span className="text-xs text-text-3 ml-2">Max tool calls per run</span>
      </div>
      <div className="flex items-center gap-2">
        <input
          type="number"
          min={1}
          max={500}
          className="input input-sm w-[72px] text-center"
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value);
            setSaved(false);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") save();
          }}
        />
        <button className="btn" disabled={!dirty || saving} onClick={save}>
          {saving ? "Saving…" : saved ? "Saved" : "Save"}
        </button>
        <span className="text-xs text-text-3">Agent summarises progress and stops when this limit is hit.</span>
      </div>
    </div>
  );
}
