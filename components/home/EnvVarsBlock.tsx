"use client";

import { useState, useEffect } from "react";

interface SecretMeta {
  name: string;
  createdAt: string;
  domains: string[];
}

export default function EnvVarsBlock({ wsId }: { wsId: string }) {
  const [secrets, setSecrets] = useState<SecretMeta[]>([]);
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const [domains, setDomains] = useState<string[]>([""]);
  const [showForm, setShowForm] = useState(false);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  // Secrets are unreachable with no network route out, so there's nothing useful to view or add
  // while off — hide the management UI entirely instead of showing controls that can't do anything.
  const [internetAccess, setInternetAccess] = useState(false);

  useEffect(() => {
    fetch(`/api/workspaces/${wsId}/env-vars`)
      .then((r) => r.json())
      .then((d: SecretMeta[]) => setSecrets(d))
      .catch(() => {});
    fetch(`/api/workspaces/${wsId}/internet-access`)
      .then((r) => r.json())
      .then((d: { enabled: boolean }) => setInternetAccess(d.enabled))
      .catch(() => {});
  }, [wsId]);

  const resetForm = () => {
    setName("");
    setValue("");
    setDomains([""]);
    setError(null);
  };

  const setDomainValue = (idx: number, val: string) => {
    setDomains((prev) => prev.map((d, i) => (i === idx ? val : d)));
  };

  const addDomainField = () => setDomains((prev) => [...prev, ""]);

  const removeDomainField = (idx: number) => {
    setDomains((prev) => (prev.length === 1 ? [""] : prev.filter((_, i) => i !== idx)));
  };

  const trimmedDomains = domains.map((d) => d.trim()).filter((d) => d.length > 0);

  const add = async () => {
    setError(null);
    setAdding(true);
    try {
      const res = await fetch(`/api/workspaces/${wsId}/env-vars`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim(), value: value.trim(), domains: trimmedDomains }),
      });
      if (!res.ok) {
        const d = (await res.json()) as { error?: string };
        setError(d.error ?? "Failed to save");
        return;
      }
      resetForm();
      setShowForm(false);
      const updated = (await fetch(`/api/workspaces/${wsId}/env-vars`).then((r) => r.json())) as SecretMeta[];
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

  if (!internetAccess) {
    return (
      <div className="flex flex-col gap-2 mt-4 border border-border rounded-card p-[14px_16px] bg-bg-tint">
        <div>
          <span className="text-ms font-semibold text-text">Third-party secrets</span>
          <span className="text-xs text-text-3 ml-2">unavailable while internet access is off</span>
        </div>
        <p className="m-0 text-xs text-text-3">
          This workspace has no network route out, so secrets can&apos;t be reached anyway. Turn internet
          access back on above to view or add them.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3 mt-4 border border-border rounded-card p-[14px_16px] bg-bg-tint">
      <div>
        <span className="text-ms font-semibold text-text">Third-party secrets</span>
        <span className="text-xs text-text-3 ml-2">kept out of the agent&apos;s context</span>
      </div>

      {secrets.length > 0 && (
        <div className="flex flex-col gap-1.5">
          {secrets.map((s) => (
            <div
              key={s.name}
              className="flex items-center justify-between gap-2 text-ms bg-white border border-border rounded-ctrl px-2.5 py-1.5"
            >
              <div className="flex items-center gap-2 min-w-0">
                <code className="font-mono text-xs text-text shrink-0">{s.name}</code>
                {s.domains?.length ? (
                  <span className="text-xs text-text-muted truncate">→ {s.domains.join(", ")}</span>
                ) : null}
              </div>
              {confirmDelete === s.name ? (
                <div className="flex items-center gap-2 shrink-0">
                  <button className="btn btn-danger btn-sm" onClick={() => remove(s.name)}>
                    Delete
                  </button>
                  <button className="linkbtn" onClick={() => setConfirmDelete(null)}>
                    Cancel
                  </button>
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
        <button
          className="btn btn-sm self-start"
          onClick={() => {
            resetForm();
            setShowForm(true);
          }}
        >
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

          <div className="flex flex-col gap-1">
            <span className="text-xs font-medium text-text">Allowed hosts</span>
            <div className="flex flex-col gap-2">
              {domains.map((host, idx) => (
                <div className="flex items-center gap-2" key={idx}>
                  <input
                    className="input input-sm font-mono flex-1"
                    value={host}
                    onChange={(e) => setDomainValue(idx, e.target.value)}
                  />
                  {domains.length > 1 && (
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm px-2 text-text-3"
                      aria-label="Remove host"
                      onClick={() => removeDomainField(idx)}
                    >
                      ×
                    </button>
                  )}
                </div>
              ))}
            </div>
            <button type="button" className="linkbtn text-primary mt-1 self-start" onClick={addDomainField}>
              + Add host
            </button>
          </div>

          {error && <p className="text-xs text-danger m-0">{error}</p>}

          <div className="flex items-center gap-2">
            <button
              className="btn btn-sm"
              onClick={add}
              disabled={adding || !name || !value || trimmedDomains.length === 0}
            >
              {adding ? "Saving…" : "Save secret"}
            </button>
            <button
              className="linkbtn"
              onClick={() => {
                setShowForm(false);
                resetForm();
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
