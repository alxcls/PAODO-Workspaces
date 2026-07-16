// Centre pane that displays workspace files with syntax highlighting and inline editing.
// File-change / file-delete notifications arrive via the imperative handle, called by the
// workspace page which owns the shared WebSocket. Data operations are handled by useFileContent.
"use client";

import { useState, useEffect, forwardRef, useImperativeHandle } from "react";
import dynamic from "next/dynamic";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useFileContent } from "@/lib/client/hooks/useFileContent";

// CodeMirror touches the DOM on import, so load it client-side only (no SSR).
const CodeMirrorEditor = dynamic(() => import("./CodeMirrorEditor"), { ssr: false });

const CloseIcon = () => (
  <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
    <path d="M4 4l8 8M12 4l-8 8" />
  </svg>
);

export interface FileViewerHandle {
  notifyFilesChanged: (paths: string[]) => void;
  notifyFilesDeleted: (paths: string[]) => void;
  notifyFileMoveStarted: (sourceRoot: string) => void;
  notifyFileMoveCancelled: (sourceRoot: string) => void;
  notifyFileMoved: (sourceRoot: string, destinationRoot: string) => void;
}

interface Props {
  workspaceId: string; filePath: string | null;
  onClose: () => void; onSelfWrite?: (path: string) => void;
  /** API base for file routes. Defaults to the workspace path; drives pass /api/drives/<id>. */
  apiBase?: string;
}

const FileViewer = forwardRef<FileViewerHandle, Props>(function FileViewer(
  { workspaceId, filePath, onClose, onSelfWrite, apiBase },
  ref
) {
  const base = apiBase ?? `/api/workspaces/${workspaceId}`;
  const {
    fileType, content, draft, setDraft,
    loading, error, saving, deleting, moving,
    isDirty,
    handleSave, deleteFile,
    notifyFilesChanged, notifyFilesDeleted,
    notifyFileMoveStarted, notifyFileMoveCancelled, notifyFileMoved,
  } = useFileContent(workspaceId, filePath, { onClose, onSelfWrite, apiBase: base });

  // Markdown files can toggle a rendered preview; all other files are source-only.
  const isMarkdown = /\.(md|markdown)$/i.test(filePath ?? "");

  const [showPreview, setShowPreview] = useState(false);
  useEffect(() => {
    setShowPreview(isMarkdown);
  }, [isMarkdown]);

  useImperativeHandle(ref, () => ({
    notifyFilesChanged,
    notifyFilesDeleted,
    notifyFileMoveStarted,
    notifyFileMoveCancelled,
    notifyFileMoved,
  }), [
    notifyFilesChanged,
    notifyFilesDeleted,
    notifyFileMoveStarted,
    notifyFileMoveCancelled,
    notifyFileMoved,
  ]);

  async function handleDelete() {
    if (!filePath || !confirm(`Delete ${filePath.split("/").pop()}?`)) return;
    deleteFile();
  }

  const displayPath = filePath ? filePath.split("/").slice(-3).join("/") : "";
  const rawUrl = filePath
    ? `${base}/files/content?path=${encodeURIComponent(filePath)}&raw=1`
    : "";

  const closeBtn = (
    <button className="iconbtn" onClick={onClose} title="Close viewer" aria-label="Close viewer">
      <CloseIcon />
    </button>
  );

  if (!filePath) {
    return (
      <div className="flex flex-col min-h-0 flex-1">
        <div className="flex items-center gap-2.5 px-4 min-h-[44px] border-b border-border bg-bg flex-shrink-0">
          <span className="font-mono text-ms text-text-3 flex-1 min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">No file open</span>
          {closeBtn}
        </div>
        <div className="flex-1 grid place-items-center text-text-3 text-sm bg-bg-tint p-6 text-center">
          Select a file from the tree to view its contents
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col min-h-0 flex-1">
      <div className="flex items-center gap-2.5 px-4 min-h-[44px] border-b border-border bg-bg flex-shrink-0">
        <span className="font-mono text-ms text-text-2 flex-1 min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">
          {displayPath}
        </span>
        {!loading && !error && fileType !== null && (
          <>
            {fileType === "text" && isMarkdown && (
              <button className="btn btn-sm" onClick={() => setShowPreview(v => !v)}
                title={showPreview ? "Switch to editor" : "Switch to preview"}>
                {showPreview ? "Code" : "Preview"}
              </button>
            )}
            {fileType === "text" && (
              <button
                className="btn btn-sm btn-primary"
                onClick={handleSave}
                disabled={!isDirty || saving || deleting || moving}
              >
                {saving ? "Saving…" : moving ? "Moving…" : "Save"}
              </button>
            )}
            <button
              className="btn btn-sm text-danger"
              onClick={handleDelete}
              disabled={deleting || saving || moving}
            >
              {deleting ? "Deleting…" : "Delete"}
            </button>
          </>
        )}
        {closeBtn}
      </div>

      {loading && <div className="flex-1 grid place-items-center text-text-3 text-sm bg-bg-tint p-6 text-center">Loading…</div>}
      {error && <div className="flex-1 grid place-items-center text-sm bg-bg-tint p-6 text-center text-danger">{error}</div>}

      {!loading && !error && fileType === "image" && (
        <div className="flex-1 grid place-items-center bg-bg-tint overflow-auto p-4">
          <img src={rawUrl} alt={filePath.split("/").pop()} className="max-w-full object-contain rounded" />
        </div>
      )}

      {!loading && !error && fileType === "binary" && (
        <div className="flex-1 grid place-items-center text-text-3 text-sm bg-bg-tint p-6 text-center">
          Binary file — cannot be previewed
        </div>
      )}

      {!loading && !error && fileType === "text" && content !== null && (
        <div className="code-editor-wrap">
          {showPreview ? (
            <div className="md-preview md-prose">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{draft ?? ""}</ReactMarkdown>
            </div>
          ) : (
            <CodeMirrorEditor value={draft} onChange={setDraft} filePath={filePath} />
          )}
        </div>
      )}
    </div>
  );
});

export default FileViewer;
