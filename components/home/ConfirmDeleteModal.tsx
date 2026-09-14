"use client";

import { useEffect } from "react";
import { Spinner } from "@/components/shared/Spinner";

interface ConfirmDeleteModalProps {
  name: string;
  deleting: boolean;
  onConfirm(): void;
  onCancel(): void;
}

export default function ConfirmDeleteModal({ name, deleting, onConfirm, onCancel }: ConfirmDeleteModalProps) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !deleting) onCancel();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [deleting, onCancel]);

  return (
    <div
      className="fixed inset-0 bg-[rgba(15,10,30,0.55)] backdrop-blur-[2px] flex items-center justify-center z-[1000] p-4"
      onMouseDown={(event) => {
        if (event.currentTarget === event.target && !deleting) onCancel();
      }}
    >
      <div
        className="bg-white rounded-2xl shadow-[0_18px_50px_rgba(15,10,30,0.28)] p-7 w-[min(420px,calc(100vw-32px))] border border-[rgba(15,10,30,0.08)]"
        role="dialog"
        aria-modal="true"
        aria-label="Delete workspace"
      >
        <div className="font-semibold text-[17px] text-text leading-snug">Delete workspace</div>
        <p className="text-sm text-text-2 mt-1.5 mb-0 leading-[1.55]">
          This will permanently delete <b className="text-text">{name}</b>. This action can&apos;t be undone.
        </p>

        <div className="flex gap-2.5 items-center justify-end mt-7">
          {deleting ? (
            <div className="flex items-center gap-2.5 text-sm text-text-2">
              <Spinner />
              Deleting…
            </div>
          ) : (
            <>
              <button className="btn btn-primary" onClick={onCancel}>
                Cancel
              </button>
              <button className="btn btn-danger" onClick={onConfirm}>
                Delete
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
