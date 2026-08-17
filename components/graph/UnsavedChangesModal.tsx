"use client";

import type { Node } from "@xyflow/react";
import { driveDeleteWarning } from "./types";

interface UnsavedChangesModalProps {
  pendingDriveDeletes: Node[];
  onSaveAndLeave(): void;
  onLeave(): void;
  onCancel(): void;
}

export default function UnsavedChangesModal({
  pendingDriveDeletes,
  onSaveAndLeave,
  onLeave,
  onCancel,
}: UnsavedChangesModalProps) {
  return (
    <div className="fixed inset-0 bg-[rgba(15,10,30,0.55)] flex items-center justify-center z-[1000]">
      <div className="bg-white rounded-2xl shadow-[0_18px_40px_rgba(15,10,30,0.25)] p-[30px_34px] w-[min(460px,calc(100vw-48px))] border border-[rgba(15,10,30,0.08)]">
        <div className="font-semibold text-[19px] mb-3 text-text">Unsaved changes</div>
        <p className="text-sm text-text-2 m-0 mb-[26px] leading-[1.5]">
          You have unsaved changes to the agent graph. What would you like to do?
          {pendingDriveDeletes.length > 0 && (
            <span className="block mt-2 text-danger">{driveDeleteWarning(pendingDriveDeletes)}</span>
          )}
        </p>
        <div className="flex gap-2.5 items-center flex-wrap">
          <button className="btn btn-primary" onClick={onSaveAndLeave}>
            Save &amp; leave
          </button>
          <button className="btn" onClick={onLeave}>
            Leave without saving
          </button>
          <button className="linkbtn" onClick={onCancel}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
