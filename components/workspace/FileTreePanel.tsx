"use client";

import { useRef, useState, type ChangeEvent, type CSSProperties, type DragEvent } from "react";
import { readDroppedEntries } from "@/lib/client/dropEntries";
import { useFileOperations } from "@/lib/client/hooks/useFileOperations";
import { useFileTreeMove } from "@/lib/client/hooks/useFileTreeMove";
import { useFileTreeSelection } from "@/lib/client/hooks/useFileTreeSelection";
import { useFileUpload } from "@/lib/client/hooks/useFileUpload";
import { FileTreeList } from "./FileTreeList";

const UploadIcon = () => (
  <svg
    viewBox="0 0 24 24"
    width="16"
    height="16"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
    <polyline points="17 8 12 3 7 8" />
    <line x1="12" y1="3" x2="12" y2="15" />
  </svg>
);

const UploadMenu = ({
  status,
  uploadFiles,
  uploadFolder,
}: Pick<ReturnType<typeof useFileUpload>, "status" | "uploadFiles" | "uploadFolder">) => {
  const handleFiles = (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []);
    event.target.value = "";
    uploadFiles(files);
  };

  const handleFolder = (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []);
    event.target.value = "";
    uploadFolder(files);
  };

  const busy = status !== null;
  return (
    <div className="flex flex-col gap-1 flex-1">
      <div className="flex gap-1">
        <button
          type="button"
          className={`btn btn-ghost btn-sm flex-1 justify-center relative ${busy ? "pointer-events-none opacity-50" : ""}`}
        >
          <UploadIcon />
          <span>Files</span>
          <input
            type="file"
            multiple
            className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
            onChange={handleFiles}
          />
        </button>
        <button
          type="button"
          className={`btn btn-ghost btn-sm flex-1 justify-center relative ${busy ? "pointer-events-none opacity-50" : ""}`}
        >
          <UploadIcon />
          <span>Folder</span>
          <input
            type="file"
            multiple
            // @ts-expect-error — webkitdirectory is not in React's HTMLInputElement types
            webkitdirectory=""
            className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
            onChange={handleFolder}
          />
        </button>
      </div>
      {status && <div className="text-2xs text-text-3 px-1">{status}</div>}
    </div>
  );
};

interface Props {
  workspaceId: string;
  workspaceName: string;
  selectedPath: string | null;
  onFileSelect: (path: string) => void;
  onDeletedPaths?: (paths: string[]) => void;
  onMoveStarted?: (sourcePath: string) => void;
  onMoveCancelled?: (sourcePath: string) => void;
  onMovedPath?: (sourcePath: string, destinationPath: string) => void;
  style?: CSSProperties;
  refreshKey?: number;
  /** API base for file routes. Defaults to the workspace path; drives pass /api/drives/<id>. */
  apiBase?: string;
}

export default function FileTreePanel({
  workspaceId,
  workspaceName,
  selectedPath,
  onFileSelect,
  onDeletedPaths,
  onMoveStarted,
  onMoveCancelled,
  onMovedPath,
  style,
  refreshKey,
  apiBase,
}: Props) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [draggingUpload, setDraggingUpload] = useState(false);
  // Whether the user has already closed the results popup for the upload that just finished. Reset
  // to false every time a new upload starts, so a fresh result always gets its own popup.
  const [resultsDismissed, setResultsDismissed] = useState(true);
  const uploadDragCounter = useRef(0);
  const base = apiBase ?? `/api/workspaces/${workspaceId}`;

  const selection = useFileTreeSelection();
  const operations = useFileOperations({
    workspaceId,
    workspaceName,
    selected: selection.selected,
    clearSelection: selection.clearSelection,
    onDeletedPaths,
    refreshKey,
    apiBase: base,
  });
  const upload = useFileUpload(base, operations.fetchTree);
  const treeMove = useFileTreeMove({
    tree: operations.tree,
    selected: selection.selected,
    setExpanded,
    remapSelection: selection.remapSelection,
    moveMany: operations.handleMoveMany,
    lifecycle: {
      started: onMoveStarted,
      cancelled: onMoveCancelled,
      completed: onMovedPath,
    },
  });

  const uploadBusy = upload.status !== null;

  // Every upload entry point flips this before kicking off the hook call, so that once the hook
  // finishes and sets a summary, showResults below picks it up on the next render.
  const uploadFiles = (files: File[]) => {
    setResultsDismissed(false);
    return upload.uploadFiles(files);
  };
  const uploadFolder = (files: File[]) => {
    setResultsDismissed(false);
    return upload.uploadFolder(files);
  };

  // Only pop up once the upload has actually finished (status back to null) and something failed
  // to upload — a plain, silent success shows nothing.
  const showResults = !resultsDismissed && upload.status === null && upload.summary !== null && upload.summary.failed.length > 0;

  const handleExternalDragOver = (event: DragEvent) => {
    if (!Array.from(event.dataTransfer.types).includes("Files")) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  };

  const handleExternalDragEnter = (event: DragEvent) => {
    if (!Array.from(event.dataTransfer.types).includes("Files")) return;
    event.preventDefault();
    uploadDragCounter.current += 1;
    setDraggingUpload(true);
  };

  const handleExternalDragLeave = (event: DragEvent) => {
    if (!Array.from(event.dataTransfer.types).includes("Files")) return;
    uploadDragCounter.current -= 1;
    if (uploadDragCounter.current <= 0) {
      uploadDragCounter.current = 0;
      setDraggingUpload(false);
    }
  };

  const handleExternalDrop = async (event: DragEvent) => {
    if (!Array.from(event.dataTransfer.types).includes("Files")) return;
    event.preventDefault();
    uploadDragCounter.current = 0;
    setDraggingUpload(false);
    if (uploadBusy) return;

    const { files, hasDirectory } = await readDroppedEntries(event.dataTransfer);
    if (files.length === 0) return;
    setResultsDismissed(false);
    if (hasDirectory) upload.uploadPathedFiles(files, true);
    else upload.uploadFiles(files.map((file) => file.file));
  };

  const toggleExpanded = (path: string) => {
    setExpanded((current) => ({ ...current, [path]: !current[path] }));
  };

  return (
    <aside
      className="relative flex flex-col bg-bg-tint overflow-hidden"
      style={style}
      onDragOver={handleExternalDragOver}
      onDragEnter={handleExternalDragEnter}
      onDragLeave={handleExternalDragLeave}
      onDrop={handleExternalDrop}
    >
      <div className="flex items-center gap-2 p-[14px_14px_8px]">
        <span
          className="font-semibold text-[15px] tracking-[-0.01em] whitespace-nowrap overflow-hidden text-ellipsis flex-1"
          title={workspaceName}
        >
          {workspaceName}
        </span>
      </div>

      <div className="flex gap-1.5 px-3 pb-2.5 border-b border-border">
        <UploadMenu status={upload.status} uploadFiles={uploadFiles} uploadFolder={uploadFolder} />
      </div>

      <div
        className={`relative flex-1 overflow-auto py-2 transition-colors ${treeMove.dropTargetPath === "" ? "bg-primary-tint" : ""}`}
        onDragOver={(event) => {
          if (!treeMove.draggedNodes || event.target !== event.currentTarget) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = "move";
          treeMove.setDropTargetPath("");
        }}
        onDragLeave={(event) => {
          if (event.target === event.currentTarget && treeMove.dropTargetPath === "") {
            treeMove.setDropTargetPath(null);
          }
        }}
        onDrop={(event) => {
          if (!treeMove.draggedNodes || event.target !== event.currentTarget) return;
          event.preventDefault();
          void treeMove.moveTo(null);
        }}
        title={treeMove.draggedNodes ? "Drop on empty space to move to the root folder" : undefined}
      >
        <FileTreeList
          nodes={operations.tree}
          expanded={expanded}
          toggleExpanded={toggleExpanded}
          selection={{
            activePath: selectedPath,
            selected: selection.selected,
            select: selection.handleSelect,
            selectRange: (path) => selection.selectRangeTo(operations.tree, expanded, path),
            pick: onFileSelect,
          }}
          move={{
            draggedNodes: treeMove.draggedNodes,
            dropTargetPath: treeMove.dropTargetPath,
            movingPaths: treeMove.movingPaths,
            dragStart: treeMove.handleDragStart,
            dragEnd: treeMove.handleDragEnd,
            setDropTarget: treeMove.setDropTargetPath,
            moveTo: treeMove.moveTo,
          }}
        />
        {draggingUpload && (
          <div
            className={`absolute inset-0 z-10 flex items-center justify-center pointer-events-none border-2 border-dashed ${uploadBusy ? "border-border bg-bg/80" : "border-primary bg-primary-tint/80"}`}
          >
            <div
              className={`flex flex-col items-center gap-2 text-[13.5px] font-medium ${uploadBusy ? "text-text-3" : "text-primary"}`}
            >
              <UploadIcon />
              <span>{uploadBusy ? "Upload in progress — please wait" : "Drop files or folders to upload"}</span>
            </div>
          </div>
        )}
      </div>

      {(selection.selected.size > 0 ||
        operations.deleteError ||
        operations.moveError ||
        treeMove.moveNote ||
        treeMove.movingPaths.size > 0) && (
        <div className="border-t border-border p-[10px_12px] bg-bg">
          <div className="flex gap-1">
            <button
              className="btn btn-ghost btn-sm flex-1 justify-center whitespace-nowrap items-center gap-1.5 disabled:opacity-60 disabled:cursor-wait"
              onClick={operations.handleDownload}
              disabled={operations.downloading || treeMove.movingPaths.size > 0}
            >
              {operations.downloading && (
                <span className="shrink-0 block w-3 h-3 border-2 border-current border-t-transparent rounded-full animate-spin" />
              )}
              {operations.downloading ? "Zipping…" : "Download .zip"}
            </button>
            <button
              className="btn btn-ghost btn-sm flex-1 justify-center text-danger"
              onClick={operations.handleDelete}
              disabled={operations.downloading || treeMove.movingPaths.size > 0}
            >
              Delete
            </button>
          </div>
          {operations.deleteError && (
            <div className="text-xs text-danger whitespace-pre-wrap mt-2 px-1">{operations.deleteError}</div>
          )}
          {treeMove.movingPaths.size > 0 && (
            <div className="text-xs text-text-3 mt-2 px-1">
              {treeMove.movingPaths.size > 1 ? `Moving ${treeMove.movingPaths.size} items…` : "Moving…"}
            </div>
          )}
          {operations.moveError && (
            <div className="text-xs text-danger whitespace-pre-wrap mt-2 px-1">{operations.moveError}</div>
          )}
          {treeMove.moveNote && <div className="text-xs text-text-3 mt-2 px-1">{treeMove.moveNote}</div>}
        </div>
      )}

      {showResults && upload.summary && (
        <div className="fixed inset-0 bg-[rgba(15,10,30,0.55)] flex items-center justify-center z-[1000]">
          <div className="bg-white rounded-2xl shadow-[0_18px_40px_rgba(15,10,30,0.25)] p-[34px_38px] w-[min(880px,calc(100vw-48px))] border border-[rgba(15,10,30,0.08)]">
            <div className="font-semibold text-[19px] mb-3 text-text">Upload results</div>
            <p className="text-sm text-text-2 m-0 mb-2 leading-[1.5]">
              Uploaded {upload.summary.uploaded} of {upload.summary.uploaded + upload.summary.failed.length} file
              {upload.summary.uploaded + upload.summary.failed.length === 1 ? "" : "s"} —{" "}
              {upload.summary.failed.length} failed.
            </p>
            {/* Any genuine error (disk full, path rejected, network failure, ...) that stopped the
                batch early gets its own plain-text line — separate from the count above and from
                the routine exclusion notes below, so it doesn't read as just another bullet. */}
            {upload.summary.stoppedReason && (
              <p className="text-sm text-text-2 m-0 mb-2 leading-[1.5]">{upload.summary.stoppedReason}</p>
            )}
            {upload.summary.notes.length > 0 && (
              <ul className="text-sm text-text-2 m-0 mb-3 pl-5 leading-[1.6] list-disc">
                {upload.summary.notes.map((note) => (
                  <li key={note}>{note}</li>
                ))}
              </ul>
            )}
            <div className="rounded border border-border bg-bg-tint text-2xs text-text-3 p-3 mb-[26px] max-h-[480px] overflow-y-auto font-mono whitespace-pre-wrap">
              {upload.summary.failed.map((path) => `✗ ${path}`).join("\n")}
            </div>
            <div className="flex gap-2.5 items-center flex-wrap">
              <button className="btn btn-primary" onClick={() => setResultsDismissed(true)}>
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </aside>
  );
}
