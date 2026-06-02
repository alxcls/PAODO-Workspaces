// Home page block for managing a workspace's secrets (environment variables).
// Secrets are write-only: only key NAMES are ever returned from the server. They are injected into
// secured scripts at run time (never into the agent's own shell), so the agent can't read them.
"use client";

import { useState, useEffect } from "react";

export default function SecretsBlock({ wsId }: { wsId: string }) {
  const [names, setNames] = useState<string[]>([]);
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = () =>
    fetch(`/api/workspaces/${wsId}/secrets`)
      .then((r) => r.json())
      .then((d: { names: string[] }) => setNames(d.names ?? []))
      .catch(() => {});

  useEffect(() => { refresh(); }, [wsId]);

  const add = async () => {
    const n = name.trim();
    if (!n || !value) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/workspaces/${wsId}/secrets`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: n, value }),
      });
      if (!res.ok) {
        const d = (await res.json().catch(() => ({}))) as { error?: string };
        setError(d.error ?? "Failed to save");
        return;
      }
      const d = (await res.json()) as { names: string[] };
      setNames(d.names ?? []);
      setName(""); setValue("");
    } finally { setBusy(false); }
  };

  const remove = async (n: string) => {
    const res = await fetch(`/api/workspaces/${wsId}/secrets`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: n }),
    });
    if (res.ok) {
      const d = (await res.json()) as { names: string[] };
      setNames(d.names ?? []);
    }
  };

  return (
    <div className="flex flex-col gap-3 mt-4 border border-border rounded-[--radius-card] p-[14px_16px] bg-bg-tint">
      <div>
        <span className="text-[13px] font-semibold text-text">Environment Variables</span>
        <span className="text-xs text-text-3 ml-2">Injected into secured scripts — hidden from the agent</span>
      </div>

      {names.length > 0 && (
        <div className="flex flex-col gap-1.5">
          {names.map((n) => (
            <div key={n} className="flex items-center gap-2.5 bg-white border border-border rounded-[--radius-ctrl] px-2.5 py-1.5">
              <code className="font-mono text-[12px] text-text flex-1 min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">{n}</code>
              <span className="font-mono text-[12px] text-text-3 select-none">••••••</span>
              <button className="linkbtn text-danger" onClick={() => remove(n)}>Delete</button>
            </div>
          ))}
        </div>
      )}

      <div className="flex items-center gap-2">
        <input
          className="h-8 px-2.5 rounded-[--radius-ctrl] border border-border bg-white text-[13px] font-mono w-[38%] min-w-0"
          placeholder="NAME"
          value={name}
          onChange={(e) => setName(e.target.value.toUpperCase())}
        />
        <input
          className="h-8 px-2.5 rounded-[--radius-ctrl] border border-border bg-white text-[13px] flex-1 min-w-0"
          placeholder="value"
          type="password"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") add(); }}
        />
        <button className="btn btn-sm" onClick={add} disabled={busy || !name.trim() || !value}>
          {busy ? "Saving…" : "Add"}
        </button>
      </div>

      {error && <p className="m-0 text-xs text-danger">{error}</p>}
    </div>
  );
}
