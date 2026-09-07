// The @mention popup shown above the composer. Presentational only: the parent (ChatPanel) owns the
// active index and keyboard handling so focus never leaves the textarea.
"use client";

import { useEffect, useRef } from "react";
import { truncateMiddlePath } from "@/lib/client/mentionFilter";
import type { TreeNode } from "@/lib/client/hooks/useFileOperations";

const FolderIcon = () => (
  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
    <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
  </svg>
);

const FileIcon = () => (
  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
    <path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" />
    <path d="M14 3v6h6" />
  </svg>
);

export default function MentionMenu({
  items,
  activeIndex,
  onHover,
  onSelect,
}: {
  items: TreeNode[];
  activeIndex: number;
  onHover: (i: number) => void;
  onSelect: (node: TreeNode) => void;
}) {
  const activeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  if (items.length === 0) return null;

  return (
    <div
      role="listbox"
      className="absolute left-3.5 bottom-[calc(100%+4px)] z-30 w-[min(420px,calc(100%-1.75rem))] max-h-[268px] overflow-auto rounded-lg border border-border bg-bg shadow-lg py-1"
    >
      {items.map((node, i) => {
        const isDir = node.type === "directory";
        return (
          <button
            key={node.path}
            ref={i === activeIndex ? activeRef : undefined}
            type="button"
            role="option"
            aria-selected={i === activeIndex}
            onMouseEnter={() => onHover(i)}
            onMouseDown={(e) => {
              e.preventDefault();
              onSelect(node);
            }}
            title={node.path}
            className={`flex items-center gap-2 w-full text-left px-3 py-1.5 text-[12.5px] cursor-pointer overflow-hidden ${i === activeIndex ? "bg-bg-2 text-primary-2" : "text-text-2"}`}
          >
            <span className="text-text-3 flex-none">{isDir ? <FolderIcon /> : <FileIcon />}</span>
            <span className="truncate flex-1">{truncateMiddlePath(node.path, 52)}</span>
          </button>
        );
      })}
    </div>
  );
}
