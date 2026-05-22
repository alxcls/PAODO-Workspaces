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

  const save = () => {
    saveDesc(wsId, draft);
    onChange(draft);
    setEditing(false);
  };
  const cancel = () => {
    setDraft(value);
    setEditing(false);
  };

  if (editing) {
    return (
      <div className="desc-edit">
        <textarea
          autoFocus
          className="textarea"
          rows={5}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="What is this workspace for?"
          onKeyDown={(e) => {
            if (e.key === "Escape") cancel();
          }}
        />
        <div className="desc-actions">
          <button className="btn btn-primary btn-sm" onClick={save}>Save</button>
          <button className="linkbtn" onClick={cancel}>Cancel</button>
        </div>
      </div>
    );
  }

  return (
    <div className="desc-read" onClick={() => setEditing(true)}>
      {value ? (
        <p>{value}</p>
      ) : (
        <p className="desc-placeholder">Add a description for this workspace…</p>
      )}
      <span className="desc-edit-hint">Click to edit</span>
    </div>
  );
}
