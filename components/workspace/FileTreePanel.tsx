"use client";

import { useRef, useState, type ChangeEvent, type CSSProperties, type DragEvent, type ReactNode } from "react";
import { readDroppedEntries } from "@/lib/client/dropEntries";
import { useFileOperations } from "@/lib/client/hooks/useFileOperations";
import { useFileTreeMove } from "@/lib/client/hooks/useFileTreeMove";
import { useFileTreeSelection } from "@/lib/client/hooks/useFileTreeSelection";
import { useFileUpload, type PathedFile } from "@/lib/client/hooks/useFileUpload";
import { partitionByIgnore } from "@/lib/workspace/uploadIgnore";
import { FileTreeList } from "./FileTreeList";

/** A folder upload whose ignore-pattern exclusions are waiting on the user's confirmation. */
interface PendingFolderUpload {
  entries: PathedFile[];
  included: PathedFile[];
  excluded: Map<string, PathedFile[]>;
}

/** Shared chrome for the upload popups below — the one thing they actually have in common. */
const Modal = ({ title, children }: { title: string; children: ReactNode }) => (
  <div className="fixed inset-0 bg-[rgba(15,10,30,0.55)] flex items-center justify-center z-[1000]">
    <div className="bg-white rounded-2xl shadow-[0_18px_40px_rgba(15,10,30,0.25)] p-[30px_34px] w-[min(460px,calc(100vw-48px))] border border-[rgba(15,10,30,0.08)]">
      <div className="font-semibold text-[19px] mb-3 text-text">{title}</div>
      {children}
    </div>
  </div>
);

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
  onFolderSelected,
}: Pick<ReturnType<typeof useFileUpload>, "status" | "uploadFiles"> & {
  onFolderSelected: (entries: PathedFile[]) => void;
}) => {
  const handleFiles = (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []);
    event.target.value = "";
    uploadFiles(files);
  };

  const handleFolder = (event: ChangeEvent<HTMLInputElement>) => {
    // <input webkitdirectory> yields flat File[] with webkitRelativePath carrying the structure.
    const files = Array.from(event.target.files ?? []);
    event.target.value = "";
    onFolderSelected(files.map((file) => ({ file, path: file.webkitRelativePath || file.name })));
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
  const [pendingUpload, setPendingUpload] = useState<PendingFolderUpload | null>(null);
  // Paths excluded by the ignore-pattern modal for the most recent upload — kept separately from
  // upload.notUploaded (which only knows about paths the upload attempt itself touched) so the two
  // can be shown together: one simple list of "didn't upload", no matter which reason applied.
  const [lastExcludedPaths, setLastExcludedPaths] = useState<string[]>([]);
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

  // Folder uploads (the Folder button and directory drag-and-drop, but never the plain Files
  // button or a flat-file drop) default-exclude node_modules — visibly, not silently: if anything
  // would be excluded, hold the upload and show what/why instead of just proceeding.
  const startFolderUpload = (entries: PathedFile[]) => {
    setLastExcludedPaths([]);
    const { included, excluded } = partitionByIgnore(entries);
    if (excluded.size === 0) {
      setResultsDismissed(false);
      upload.uploadPathedFiles(entries);
      return;
    }
    setPendingUpload({ entries, included, excluded });
  };

  const confirmPendingUpload = (includeEverything: boolean) => {
    if (!pendingUpload) return;
    const toUpload = includeEverything ? pendingUpload.entries : pendingUpload.included;
    setLastExcludedPaths(
      includeEverything ? [] : Array.from(pendingUpload.excluded.values()).flat().map((entry) => entry.path),
    );
    setPendingUpload(null);
    setResultsDismissed(false);
    upload.uploadPathedFiles(toUpload);
  };

  // The plain Files button and a non-directory drop never go through ignore-pattern filtering, but
  // still clear any leftover excluded-paths list from a previous folder upload.
  const uploadFlatFiles = (files: File[]) => {
    setLastExcludedPaths([]);
    setResultsDismissed(false);
    return upload.uploadFiles(files);
  };

  const notUploadedPaths = [...lastExcludedPaths, ...upload.notUploaded];
  // Only pop up once the upload has actually finished (status back to null) and there's something
  // worth reporting — a plain, silent success shows nothing.
  const showResults = !resultsDismissed && upload.status === null && (upload.error !== null || notUploadedPaths.length > 0);

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
    if (hasDirectory) startFolderUpload(files);
    else uploadFlatFiles(files.map((file) => file.file));
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
        <UploadMenu status={upload.status} uploadFiles={uploadFlatFiles} onFolderSelected={startFolderUpload} />
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

      {pendingUpload && (
        <Modal title="Some files won't be uploaded">
          <p className="text-sm text-text-2 m-0 mb-3 leading-[1.5]">
            {Array.from(pendingUpload.excluded.entries())
              .map(([name, files]) => `${name} (${files.length} file${files.length === 1 ? "" : "s"})`)
              .join(", ")}{" "}
            {pendingUpload.excluded.size === 1 ? "isn't" : "aren't"} your source — {pendingUpload.excluded.size === 1 ? "it's" : "they're"} generated by a package
            manager or build tool. Ask the agent to run the right install/build command (e.g. npm install, pip
            install, ./gradlew build) and it&apos;ll recreate them, installing the toolchain first if the workspace
            doesn&apos;t already have it.
          </p>
          <div className="flex gap-2.5 items-center flex-wrap">
            <button className="btn btn-primary" onClick={() => confirmPendingUpload(false)}>
              Upload {pendingUpload.included.length} file{pendingUpload.included.length === 1 ? "" : "s"}
            </button>
            <button className="btn" onClick={() => confirmPendingUpload(true)}>
              Include everything instead
            </button>
            <button className="linkbtn" onClick={() => setPendingUpload(null)}>
              Cancel
            </button>
          </div>
        </Modal>
      )}

      {showResults && (
        <Modal title="Upload results">
          {upload.error && <p className="text-sm text-text-2 m-0 mb-3 leading-[1.5]">{upload.error}</p>}
          {notUploadedPaths.length > 0 && (
            <div className="rounded border border-border bg-bg-tint text-2xs text-text-3 p-2 mb-[26px] max-h-52 overflow-y-auto font-mono whitespace-pre-wrap">
              {notUploadedPaths.join("\n")}
            </div>
          )}
          <div className="flex gap-2.5 items-center flex-wrap">
            <button className="btn btn-primary" onClick={() => setResultsDismissed(true)}>
              Close
            </button>
          </div>
        </Modal>
      )}
    </aside>
  );
}
