"use client";

import Image from "next/image";
import TopBar from "@/components/layout/TopBar";

interface GraphTopBarProps {
  error?: string | null;
  isDirty: boolean;
  saved: boolean;
  selectionLabel: string;
  onBack(): void;
  onAddDrive(): void;
  onDeleteSelection(): void;
  onSave(): void;
}

export default function GraphTopBar({
  error,
  isDirty,
  saved,
  selectionLabel,
  onBack,
  onAddDrive,
  onDeleteSelection,
  onSave,
}: GraphTopBarProps) {
  return (
    <TopBar
      error={error}
      left={
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onBack}
            title="Back to workspaces"
            className="w-[34px] h-[34px] rounded-[10px] overflow-hidden flex-shrink-0 inline-flex items-center justify-center bg-gradient-to-br from-primary to-primary-2 border-0 p-0 cursor-pointer"
          >
            <Image
              src="/paodo-logo.svg"
              alt="Paodo logo"
              width={34}
              height={34}
              className="block w-full h-full object-cover"
              unoptimized
            />
          </button>
          <span className="font-semibold tracking-[-0.01em] text-lg leading-none inline-flex items-center">
            PAODO Workspace agents
          </span>
        </div>
      }
      right={
        <div className="flex items-center gap-2.5">
          {isDirty && <span className="text-xs text-text-3 italic">Unsaved changes</span>}
          <button className="btn btn-ghost btn-sm" onClick={onAddDrive}>
            Add drive
          </button>
          {selectionLabel && (
            <button
              className="btn btn-ghost btn-sm text-danger"
              onClick={onDeleteSelection}
              title={`Delete ${selectionLabel}`}
            >
              Delete
            </button>
          )}
          <button className="btn btn-primary btn-sm" onClick={onSave} disabled={!isDirty}>
            {saved ? "Saved ✓" : "Save"}
          </button>
        </div>
      }
    />
  );
}
