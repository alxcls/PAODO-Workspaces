"use client";

import { useState, useEffect } from "react";

interface Secret { name: string; }

export default function SecretsBlock({ wsId }: { wsId: string }) {
  const [secrets, setSecrets] = useState<Secret[]>([]);
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = () => {
    fetch(`/api/workspaces/${wsId}/secrets`)
      .then((r) => r.json())
      .then((d: { secrets: Secret[] }) => setSecrets(d.secrets))
      .catch(() => {});
  };

  useEffect(() => { load(); }, [wsId]);

  const add = async () => {
    if (!name.trim() || value === "") return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/workspaces/${wsId}/secrets`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim(), value }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string };
        setError(body.error ?? "Failed to save");
        return;
      }
      setName(""); setValue("");
      load();
    } finally {
      setSaving(false);
    }
  };

  const remove = async (n: string) => {
    await fetch(`/api/workspaces/${wsId}/secrets?name=${encodeURIComponent(n)}`, { method: "DELETE" });
    load();
  };

  return (
    <div className="flex flex-col gap-3 mt-4 border border-border rounded-[--radius-card] p-[14px_16px] bg-bg-tint">
      <div>
        <span className="text-[13px] font-semibold text-text">Secrets</span>
        <span className="text-xs text-text-3 ml-2">Injected as env vars into privileged scripts</span>
      </div>

      {secrets.length > 0 && (
        <div className="flex flex-col gap-1">
          {secrets.map((s) => (
            <div key={s.name} className="flex items-center justify-between gap-2 px-2 py-1.5 bg-white border border-border rounded-[--radius-ctrl] text-[13px]">
              <code className="font-mono text-text">{s.name}</code>
              <button className="linkbtn text-danger text-xs" onClick={() => remove(s.name)}>Remove</button>
            </div>
          ))}
        </div>
      )}

      <div className="flex gap-2 items-start">
        <input
          className="input input-sm flex-1"
          placeholder="NAME"
          value={name}
          onChange={(e) => { setName(e.target.value); setError(null); }}
          onKeyDown={(e) => { if (e.key === "Enter") add(); }}
        />
        <input
          className="input input-sm flex-1"
          placeholder="value"
          type="password"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") add(); }}
        />
        <button
          className="btn btn-sm flex-shrink-0"
          disabled={!name.trim() || value === "" || saving}
          onClick={add}
        >
          {saving ? "Saving…" : "Add"}
        </button>
      </div>

      {error && <div className="text-xs text-danger">{error}</div>}
    </div>
  );
}
