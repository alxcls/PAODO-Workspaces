"use client";

import { useState, useEffect } from "react";

interface SecretMeta {
  name: string;
  createdAt: string;
  domain: string;
}

export default function EnvVarsBlock({ wsId }: { wsId: string }) {
  const [secrets, setSecrets] = useState<SecretMeta[]>([]);
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const [domain, setDomain] = useState("");
  const [showForm, setShowForm] = useState(false);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  useEffect(() => {
    fetch(`/api/workspaces/${wsId}/env-vars`)
      .then((r) => r.json())
      .then((d: SecretMeta[]) => setSecrets(d))
      .catch(() => {});
  }, [wsId]);

  const resetForm = () => {
    setName(""); setValue(""); setDomain(""); setError(null);
  };

  const add = async () => {
    setError(null);
    setAdding(true);
    try {
      const res = await fetch(`/api/workspaces/${wsId}/env-vars`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim(), value: value.trim(), domain: domain.trim() }),
      });
      if (!res.ok) {
        const d = (await res.json()) as { error?: string };
        setError(d.error ?? "Failed to save");
        return;
      }
      resetForm();
      setShowForm(false);
      const updated = await fetch(`/api/workspaces/${wsId}/env-vars`).then((r) => r.json()) as SecretMeta[];
      setSecrets(updated);
    } finally {
      setAdding(false);
    }
  };

  const remove = async (secretName: string) => {
    await fetch(`/api/workspaces/${wsId}/env-vars/${encodeURIComponent(secretName)}`, { method: "DELETE" });
    setConfirmDelete(null);
    setSecrets((prev) => prev.filter((s) => s.name !== secretName));
  };

  return (
    <div className="flex flex-col gap-3 mt-4 border border-border rounded-card p-[14px_16px] bg-bg-tint">
      <div>
        <span className="text-ms font-semibold text-text">Third-party secrets</span>
        <span className="text-xs text-text-3 ml-2">kept out of the agent&apos;s context</span>
      </div>

      {secrets.length > 0 && (
        <div className="flex flex-col gap-1.5">
          {secrets.map((s) => (
            <div key={s.name} className="flex items-center justify-between gap-2 text-ms bg-white border border-border rounded-ctrl px-2.5 py-1.5">
              <div className="flex items-center gap-2 min-w-0">
                <code className="font-mono text-xs text-text shrink-0">{s.name}</code>
                {s.domain && <span className="text-xs text-text-muted truncate">→ {s.domain}</span>}
              </div>
              {confirmDelete === s.name ? (
                <div className="flex items-center gap-2 shrink-0">
                  <button className="btn btn-danger btn-sm" onClick={() => remove(s.name)}>Delete</button>
                  <button className="linkbtn" onClick={() => setConfirmDelete(null)}>Cancel</button>
                </div>
              ) : (
                <button className="linkbtn text-danger shrink-0" onClick={() => setConfirmDelete(s.name)}>
                  Delete
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      {!showForm ? (
        <button className="btn btn-sm self-start" onClick={() => { resetForm(); setShowForm(true); }}>
          Add a secret
        </button>
      ) : (
        <div className="flex flex-col gap-3 bg-white border border-border rounded-ctrl p-[12px_14px]">
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-text">Name</span>
            <input
              className="input input-sm font-mono"
              value={name}
              onChange={(e) => setName(e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, ""))}
            />
          </label>

          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-text">Value</span>
            <input
              className="input input-sm"
              type="password"
              autoComplete="new-password"
              value={value}
              onChange={(e) => setValue(e.target.value)}
            />
          </label>

          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-text">Allowed host</span>
            <input
              className="input input-sm font-mono"
              value={domain}
              onChange={(e) => setDomain(e.target.value)}
            />
          </label>

          {error && <p className="text-xs text-danger m-0">{error}</p>}

          <div className="flex items-center gap-2">
            <button
              className="btn btn-sm"
              onClick={add}
              disabled={adding || !name || !value || !domain}
            >
              {adding ? "Saving…" : "Save secret"}
            </button>
            <button className="linkbtn" onClick={() => { setShowForm(false); resetForm(); }}>Cancel</button>
          </div>
        </div>
      )}
    </div>
  );
}
