"use client";

// Create-a-drive popover. Owns its own draft so the editor holds no field state, and stays open on
// failure so the user can correct the input.
import { useState } from "react";
import { Spinner } from "@/components/shared/Spinner";

interface DriveFormProps {
  onCreate(name: string, description: string): Promise<boolean>;
  onClose(): void;
}

export default function DriveForm({ onCreate, onClose }: DriveFormProps) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [creating, setCreating] = useState(false);

  // Locked while a create is in flight so it can't be sent twice or closed halfway.
  const submit = async () => {
    if (creating) return;
    setCreating(true);
    try {
      if (await onCreate(name, description)) onClose();
    } finally {
      setCreating(false);
    }
  };
  const close = () => {
    if (!creating) onClose();
  };

  return (
    <div className="absolute top-3 right-3 z-20 bg-white border border-border rounded-card p-3 shadow-md flex flex-col gap-2 w-[260px]">
      <div className="font-semibold text-sm text-text">New shared drive</div>
      <input
        autoFocus
        className="input"
        placeholder="Drive name (no spaces)"
        value={name}
        readOnly={creating}
        onChange={(event) => setName(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") void submit();
          if (event.key === "Escape") close();
        }}
      />
      <textarea
        className="input resize-none"
        rows={3}
        placeholder="Description (optional)"
        value={description}
        readOnly={creating}
        onChange={(event) => setDescription(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") close();
        }}
      />
      <div className="flex gap-2 items-center">
        <button
          className="btn btn-primary btn-sm gap-1.5 disabled:opacity-100 disabled:bg-primary disabled:border-primary disabled:cursor-wait"
          disabled={creating}
          aria-busy={creating}
          onClick={() => void submit()}
        >
          {creating && <Spinner className="w-3 h-3" decorative />}
          {creating ? "Creating…" : "Create"}
        </button>
        <button className="linkbtn" disabled={creating} onClick={onClose}>
          Cancel
        </button>
      </div>
    </div>
  );
}
