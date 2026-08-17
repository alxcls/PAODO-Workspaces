"use client";

// Create-a-drive popover. Owns its own draft so the editor holds no field state, and stays open on
// failure so the user can correct the input.
import { useState } from "react";

interface DriveFormProps {
  onCreate(name: string, description: string): Promise<boolean>;
  onClose(): void;
}

export default function DriveForm({ onCreate, onClose }: DriveFormProps) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");

  const submit = async () => {
    if (await onCreate(name, description)) onClose();
  };

  return (
    <div className="absolute top-3 right-3 z-20 bg-white border border-border rounded-card p-3 shadow-md flex flex-col gap-2 w-[260px]">
      <div className="font-semibold text-sm text-text">New shared drive</div>
      <input
        autoFocus
        className="input"
        placeholder="Drive name (no spaces)"
        value={name}
        onChange={(event) => setName(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") void submit();
          if (event.key === "Escape") onClose();
        }}
      />
      <textarea
        className="input resize-none"
        rows={3}
        placeholder="Description (optional)"
        value={description}
        onChange={(event) => setDescription(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") onClose();
        }}
      />
      <div className="flex gap-2 items-center">
        <button className="btn btn-primary btn-sm" onClick={() => void submit()}>
          Create
        </button>
        <button className="linkbtn" onClick={onClose}>
          Cancel
        </button>
      </div>
    </div>
  );
}
