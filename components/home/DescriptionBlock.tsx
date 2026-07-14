// Home page block for editing a persisted workspace description.
"use client";

import { useState, useEffect } from "react";

export default function DescriptionBlock({
  value,
  onChange,
}: {
  value: string;
  onChange: (d: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);

  useEffect(() => setDraft(value), [value]);

  const save = () => { onChange(draft); setEditing(false); };
  const cancel = () => { setDraft(value); setEditing(false); };

  return (
    <div
      className={`relative flex flex-col border rounded-card p-[16px_18px] transition-[border-color,background] duration-[140ms] ${editing ? "border-primary-2 bg-bg" : "border-border bg-bg-tint cursor-text hover:border-primary-2 hover:bg-bg group"}`}
      style={{ height: 240 }}
      onClick={() => { if (!editing) setEditing(true); }}
    >
      {editing ? (
        <>
          <textarea
            autoFocus
            className="w-full flex-1 min-h-0 resize-none border-0 bg-transparent p-0 outline-none text-text leading-[1.55]"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="What is this workspace for?"
            onKeyDown={(e) => { if (e.key === "Escape") cancel(); }}
          />
          <div className="mt-2 flex gap-2 items-center">
            <button className="btn btn-primary btn-sm" onClick={save}>Save</button>
            <button className="linkbtn" onClick={cancel}>Cancel</button>
          </div>
        </>
      ) : value ? (
        <p className="m-0 text-text leading-[1.55] whitespace-pre-wrap">{value}</p>
      ) : (
        <p className="m-0 text-text-3">Add a description for this workspace…</p>
      )}
      <span className="absolute right-3 bottom-2 text-2xs text-text-3 opacity-0 group-hover:opacity-100 transition-opacity duration-[140ms]">
        Click to edit
      </span>
    </div>
  );
}
