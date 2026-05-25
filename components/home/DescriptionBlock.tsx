// Home page block for editing a workspace's freeform description.
// Persists text to localStorage keyed by workspace ID and toggles between read and edit modes inline.
"use client";

import { useState, useEffect } from "react";

export function loadDesc(id: string) {
  try { return localStorage.getItem(`ws-desc-${id}`) ?? ""; } catch { return ""; }
}
export function saveDesc(id: string, desc: string) {
  try { localStorage.setItem(`ws-desc-${id}`, desc); } catch { /* noop */ }
}

export default function DescriptionBlock({
  wsId,
  value,
  onChange,
}: {
  wsId: string;
  value: string;
  onChange: (d: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);

  useEffect(() => setDraft(value), [value]);

  const save = () => { saveDesc(wsId, draft); onChange(draft); setEditing(false); };
  const cancel = () => { setDraft(value); setEditing(false); };

  if (editing) {
    return (
      <div className="flex flex-col gap-2">
        <textarea
          autoFocus
          className="textarea"
          rows={5}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="What is this workspace for?"
          onKeyDown={(e) => { if (e.key === "Escape") cancel(); }}
        />
        <div className="flex gap-2 items-center">
          <button className="btn btn-primary btn-sm" onClick={save}>Save</button>
          <button className="linkbtn" onClick={cancel}>Cancel</button>
        </div>
      </div>
    );
  }

  return (
    <div
      className="relative border border-border rounded-[--radius-card] bg-bg-tint p-[16px_18px] min-h-[110px] cursor-text transition-[border-color,background] duration-[140ms] hover:border-primary-2 hover:bg-bg group"
      onClick={() => setEditing(true)}
    >
      {value ? (
        <p className="m-0 text-text leading-[1.55] whitespace-pre-wrap">{value}</p>
      ) : (
        <p className="m-0 text-text-3">Add a description for this workspace…</p>
      )}
      <span className="absolute right-3 bottom-2 text-[11px] text-text-3 opacity-0 group-hover:opacity-100 transition-opacity duration-[140ms]">
        Click to edit
      </span>
    </div>
  );
}
