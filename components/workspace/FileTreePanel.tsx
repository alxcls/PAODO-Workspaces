"use client";

import { useRef, useState } from "react";
import { useFileTreeSelection } from "@/lib/client/hooks/useFileTreeSelection";
import { useFileOperations, TreeNode } from "@/lib/client/hooks/useFileOperations";
import { useFileUpload } from "@/lib/client/hooks/useFileUpload";
import { useTransientMessage } from "@/lib/client/hooks/useTransientMessage";
import { readDroppedEntries } from "@/lib/client/dropEntries";
import { canMoveAllToDirectory, collapseToRoots, remapMovedPath } from "@/lib/client/fileMove";
import {
  flattenTree, flattenVisible, pathWithDescendants, selectionRange, sortTreeNodes,
} from "@/lib/client/fileTreeOrder";

type CheckState = "none" | "some" | "all";
type DraggedTreeNode = Pick<TreeNode, "name" | "path" | "type">;

const INTERNAL_DRAG_TYPE = "application/x-paodo-tree-path";

// ---- Icons ----
const UploadIcon = () => (
  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="17 8 12 3 7 8" /><line x1="12" y1="3" x2="12" y2="15" />
  </svg>
);
const FileIcon = () => (
  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14 2 14 8 20 8" />
  </svg>
);
const FolderIcon = () => (
  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
  </svg>
);
const ChevIcon = () => (
  <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="9 18 15 12 9 6" />
  </svg>
);

// ---- Helpers ----
function getNodeCheckState(node: TreeNode, selected: Set<string>): CheckState {
  if (selected.has(node.path)) return "all";
  if (node.type === "file") return "none";
  const anyDescendant = flattenTree(node.children ?? []).some((n) => selected.has(n.path));
  return anyDescendant ? "some" : "none";
}

/**
 * Browsers render a stack-with-count only for their own multi-file drags, so a multi-row drag has
 * to supply its own ghost. setDragImage snapshots the node synchronously and only if it is laid
 * out — hence attached to the document and merely pushed off-screen rather than hidden — after
 * which it can go away again.
 */
function setCountDragImage(e: React.DragEvent, count: number) {
  const ghost = document.createElement("div");
  ghost.textContent = `${count} items`;
  ghost.style.cssText = [
    "position:fixed", "top:-1000px", "left:-1000px",
    "padding:4px 10px", "border-radius:6px", "white-space:nowrap",
    "background:#111827", "color:#fff", "font:500 12px system-ui,sans-serif",
  ].join(";");
  document.body.appendChild(ghost);
  e.dataTransfer.setDragImage(ghost, 12, 12);
  setTimeout(() => ghost.remove(), 0);
}

// ---- Checkbox ----
// Only a fully checked box is filled in: a folder holding a checked child draws as unchecked, and
// the row's tint is what hints at the selection inside it. The mixed state still reaches assistive
// tech through aria-checked, which is not tied to the visual.
const Checkbox = ({ state, onClick }: { state: CheckState; onClick: (e: React.MouseEvent) => void }) => (
  <span
    className={`w-[14px] h-[14px] rounded-[3px] inline-flex items-center justify-center flex-shrink-0 transition-[border-color,background] duration-[120ms] border-[1.4px] cursor-pointer
      ${state === "all" ? "bg-select border-select text-white" : "bg-white border-border hover:border-select"}`}
    onClick={onClick}
    role="checkbox"
    aria-checked={state === "all" ? "true" : state === "some" ? "mixed" : "false"}
  >
    {state === "all" && (
      <svg viewBox="0 0 16 16" width="10" height="10" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
        <polyline points="3 9 6.5 12.5 13 4" />
      </svg>
    )}
  </span>
);

// ---- Tree node list ----
interface TreeListProps {
  nodes: TreeNode[]; depth: number; parentDirectory: string | null;
  expanded: Record<string, boolean>;
  onToggle: (path: string) => void; activePath: string | null;
  selected: Set<string>; onSelect: (paths: string[], on: boolean) => void;
  onRangeSelect: (path: string) => void;
  onPick: (path: string) => void;
  draggedNodes: DraggedTreeNode[] | null; dropTargetPath: string | null;
  movingPaths: Set<string>;
  onNodeDragStart: (node: TreeNode, e: React.DragEvent) => void;
  onNodeDragEnd: () => void;
  onDropTargetChange: (path: string | null) => void;
  onMove: (destinationDirectory: string | null) => void;
}

/**
 * Drag handlers for one row acting as a drop zone. A folder row targets itself; a file row targets
 * the folder containing it, so the two differ only in `targetKey` (which row highlights, "" being
 * the tree root) and `destination` (what the move request receives, null being the tree root).
 * What is being dragged lives in the panel, so a drop only has to name where it landed.
 */
function dropZoneHandlers({
  targetKey, destination, canDrop, isDragging, dropTargetPath, onDropTargetChange, onMove,
}: {
  targetKey: string;
  destination: string | null;
  canDrop: boolean;
  isDragging: boolean;
} & Pick<TreeListProps, "dropTargetPath" | "onDropTargetChange" | "onMove">) {
  return {
    onDragOver: (e: React.DragEvent) => {
      if (!isDragging) return;
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = canDrop ? "move" : "none";
      onDropTargetChange(canDrop ? targetKey : null);
    },
    onDragLeave: (e: React.DragEvent) => {
      // A row's own children (its checkbox, its label) fire dragleave on the row with relatedTarget
      // set to the child. Treat those as staying put, or the highlight drops and the next dragover
      // restores it — a flicker as the cursor crosses the row.
      if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
      if (dropTargetPath === targetKey) onDropTargetChange(null);
    },
    onDrop: (e: React.DragEvent) => {
      if (!isDragging) return;
      e.preventDefault();
      e.stopPropagation();
      onDropTargetChange(null);
      if (canDrop) onMove(destination);
    },
  };
}

const TreeNodeList = ({
  nodes, depth, parentDirectory, expanded, onToggle, activePath, selected, onSelect,
  onRangeSelect, onPick,
  draggedNodes, dropTargetPath, movingPaths,
  onNodeDragStart, onNodeDragEnd, onDropTargetChange, onMove,
}: TreeListProps) => {
  const isDragging = draggedNodes !== null;

  return (
    <>
      {sortTreeNodes(nodes).map((node) => {
        if (node.type === "directory") {
          const isOpen = expanded[node.path] ?? false;
          const state = getNodeCheckState(node, selected);
          const canDrop = draggedNodes
            ? canMoveAllToDirectory(draggedNodes, node.path)
            : false;
          const isDropTarget = canDrop && dropTargetPath === node.path;
          return (
            <div key={node.path} className={isDropTarget ? "bg-primary-tint" : ""}>
              <button
                className={`flex items-center w-full border-0 border-l-[3px] bg-transparent py-[5px] pl-2 pr-2 text-[13.5px] text-text cursor-pointer text-left transition-[background,border-color,color,opacity] duration-[120ms] hover:bg-black/[.04]
                  ${isDropTarget ? "bg-primary-tint border-l-primary" : "border-l-transparent"}
                  ${state !== "none" ? "bg-select-tint" : ""}
                  ${movingPaths.has(node.path) ? "opacity-50" : ""}`}
                onClick={(e) => {
                  if (e.shiftKey) { onRangeSelect(node.path); return; }
                  onToggle(node.path);
                }}
                draggable={movingPaths.size === 0}
                onDragStart={(e) => onNodeDragStart(node, e)}
                onDragEnd={onNodeDragEnd}
                {...dropZoneHandlers({
                  targetKey: node.path, destination: node.path, canDrop,
                  isDragging, dropTargetPath, onDropTargetChange, onMove,
                })}
              >
                <Checkbox state={state} onClick={(e) => {
                  e.stopPropagation();
                  if (e.shiftKey) { onRangeSelect(node.path); return; }
                  // Selecting/deselecting a folder cascades to every descendant so child
                  // folders and files reflect (and are included in) the selection.
                  onSelect(pathWithDescendants(node), state === "none");
                }} />
                <div className="flex items-center gap-1.5 flex-1 min-w-0 overflow-hidden" style={{ marginLeft: 6 + depth * 14 }}>
                  <span className={`inline-flex items-center justify-center w-3 h-3 flex-shrink-0 transition-transform duration-[150ms] text-text-3 ${isOpen ? "rotate-90" : ""}`}>
                    <ChevIcon />
                  </span>
                  <span className="text-text-2 inline-flex flex-shrink-0"><FolderIcon /></span>
                  <span className="flex-1 whitespace-nowrap overflow-hidden text-ellipsis">{node.name}</span>
                </div>
              </button>
              {isOpen && node.children && (
                <TreeNodeList
                  nodes={node.children} depth={depth + 1} parentDirectory={node.path}
                  expanded={expanded}
                  onToggle={onToggle} activePath={activePath} selected={selected}
                  onSelect={onSelect} onRangeSelect={onRangeSelect} onPick={onPick}
                  draggedNodes={draggedNodes} dropTargetPath={dropTargetPath}
                  movingPaths={movingPaths} onNodeDragStart={onNodeDragStart}
                  onNodeDragEnd={onNodeDragEnd} onDropTargetChange={onDropTargetChange}
                  onMove={onMove}
                />
              )}
            </div>
          );
        }

        const isActive = node.path === activePath;
        const isSel = selected.has(node.path);
        // A file row is a drop zone for the folder holding it; at the tree root there is no folder
        // to reject the drop, so anything being dragged is accepted.
        const canDropBesideFile = draggedNodes && parentDirectory !== null
          ? canMoveAllToDirectory(draggedNodes, parentDirectory)
          : isDragging;
        return (
          <button
            key={node.path}
            className={`flex items-center w-full border-0 border-l-[3px] bg-transparent py-[5px] pl-2 pr-2 text-[13.5px] cursor-pointer text-left transition-[background,border-color,color] duration-[120ms]
              ${isActive
                ? "bg-primary-tint border-l-primary text-primary"
                : `border-l-transparent text-text hover:bg-black/[.04] ${isSel ? "bg-select-tint" : ""}`
              }
              ${movingPaths.has(node.path) ? "opacity-50" : ""}`}
            onClick={(e) => {
              if (e.shiftKey) { onRangeSelect(node.path); return; }
              onPick(node.path);
            }}
            draggable={movingPaths.size === 0}
            onDragStart={(e) => onNodeDragStart(node, e)}
            onDragEnd={onNodeDragEnd}
            {...dropZoneHandlers({
              targetKey: parentDirectory ?? "", destination: parentDirectory,
              canDrop: canDropBesideFile,
              isDragging, dropTargetPath, onDropTargetChange, onMove,
            })}
          >
            <Checkbox
              state={isSel ? "all" : "none"}
              onClick={(e) => {
                e.stopPropagation();
                if (e.shiftKey) { onRangeSelect(node.path); return; }
                onSelect([node.path], !isSel);
              }}
            />
            <div className="flex items-center gap-1.5 flex-1 min-w-0 overflow-hidden" style={{ marginLeft: 6 + depth * 14 + 14 }}>
              <span className={`inline-flex flex-shrink-0 ${isActive ? "text-primary" : "text-text-2"}`}><FileIcon /></span>
              <span className="flex-1 whitespace-nowrap overflow-hidden text-ellipsis">{node.name}</span>
            </div>
          </button>
        );
      })}
    </>
  );
};

// ---- Upload button ----
const UploadMenu = ({
  status, error, uploadFiles, uploadFolder,
}: Pick<ReturnType<typeof useFileUpload>, "status" | "error" | "uploadFiles" | "uploadFolder">) => {
  const handleFiles = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    e.target.value = "";
    uploadFiles(files);
  };

  const handleFolder = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    e.target.value = "";
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
          <UploadIcon /><span>Files</span>
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
          <UploadIcon /><span>Folder</span>
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
      {error && <div className="text-2xs text-danger px-1">{error}</div>}
    </div>
  );
};

// ---- Main component ----
interface Props {
  workspaceId: string;
  workspaceName: string;
  selectedPath: string | null;
  onFileSelect: (path: string) => void;
  onDeletedPaths?: (paths: string[]) => void;
  onMoveStarted?: (sourcePath: string) => void;
  onMoveCancelled?: (sourcePath: string) => void;
  onMovedPath?: (sourcePath: string, destinationPath: string) => void;
  style?: React.CSSProperties;
  refreshKey?: number;
  /** API base for file routes. Defaults to the workspace path; drives pass /api/drives/<id>. */
  apiBase?: string;
}

export default function FileTreePanel({
  workspaceId, workspaceName, selectedPath,
  onFileSelect, onDeletedPaths, onMoveStarted, onMoveCancelled, onMovedPath,
  style, refreshKey, apiBase,
}: Props) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [draggedNodes, setDraggedNodes] = useState<DraggedTreeNode[] | null>(null);
  // The whole batch dims together while its moves run, and starting another drag is blocked until
  // it drains.
  const [movingPaths, setMovingPaths] = useState<Set<string>>(new Set());
  const [moveNote, setMoveNote] = useTransientMessage(3500);
  // "" is the tree root, null is no target at all — a hover the drop would reject must use null,
  // or the root lights up as though it were about to receive the item.
  const [dropTargetPath, setDropTargetPath] = useState<string | null>(null);
  const base = apiBase ?? `/api/workspaces/${workspaceId}`;

  const {
    selected, anchorPath, handleSelect, selectPaths, clearSelection, remapSelection,
  } = useFileTreeSelection();
  const {
    tree, fetchTree, handleDownload, downloading, handleDelete, deleteError,
    handleMoveMany, moveError,
  } = useFileOperations({
    workspaceId, workspaceName, selected, clearSelection, onDeletedPaths, refreshKey, apiBase: base,
  });

  const upload = useFileUpload(base, fetchTree);

  // Drag-and-drop of files/folders onto the panel. dragCounter tracks enter/leave across child
  // elements so the highlight only clears when the cursor truly leaves the panel.
  const [dragging, setDragging] = useState(false);
  const dragCounter = useRef(0);
  const busy = upload.status !== null;

  const onDragOver = (e: React.DragEvent) => {
    if (!Array.from(e.dataTransfer.types).includes("Files")) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  };
  const onDragEnter = (e: React.DragEvent) => {
    if (!Array.from(e.dataTransfer.types).includes("Files")) return;
    e.preventDefault();
    dragCounter.current += 1;
    setDragging(true);
  };
  const onDragLeave = (e: React.DragEvent) => {
    if (!Array.from(e.dataTransfer.types).includes("Files")) return;
    dragCounter.current -= 1;
    if (dragCounter.current <= 0) {
      dragCounter.current = 0;
      setDragging(false);
    }
  };
  const onDrop = async (e: React.DragEvent) => {
    if (!Array.from(e.dataTransfer.types).includes("Files")) return;
    e.preventDefault();
    dragCounter.current = 0;
    setDragging(false);
    if (busy) return;
    const { files, hasDirectory } = await readDroppedEntries(e.dataTransfer);
    if (files.length === 0) return;
    // Individual uploads keep names simple; anything with folder structure is zipped once.
    if (hasDirectory) upload.uploadPathedFiles(files);
    else upload.uploadFiles(files.map((f) => f.file));
  };

  const toggleExpanded = (path: string) =>
    setExpanded((e) => ({ ...e, [path]: !e[path] }));

  const selectRangeTo = (targetPath: string) => {
    const rows = flattenVisible(tree, expanded);
    const range = selectionRange(rows, anchorPath, targetPath);
    if (range.length === 0) return;
    // With no usable anchor the shift+click degrades to a plain check, and must anchor there so the
    // next one has something to measure from. A real range must not re-anchor, or every shift+click
    // would move the anchor and the range could only ever grow.
    const hasAnchor = anchorPath !== null && rows.some((n) => n.path === anchorPath);
    if (hasAnchor) selectPaths(range);
    else handleSelect(range, true);
  };

  /**
   * What a drag actually carries: the whole checked set when the grabbed row is part of it, and
   * just the grabbed row otherwise — grabbing something unchecked ignores the selection, as
   * everywhere else. Nested paths collapse so a checked folder and its checked contents move once.
   */
  const dragSources = (node: TreeNode): DraggedTreeNode[] => {
    const single = [{ name: node.name, path: node.path, type: node.type }];
    if (!selected.has(node.path) || selected.size <= 1) return single;
    const byPath = new Map(flattenTree(tree).map((n) => [n.path, n]));
    const roots = collapseToRoots(Array.from(selected))
      .map((path) => byPath.get(path))
      .filter((n): n is TreeNode => n !== undefined)
      .map((n) => ({ name: n.name, path: n.path, type: n.type }));
    return roots.length > 0 ? roots : single;
  };

  const onNodeDragStart = (node: TreeNode, e: React.DragEvent) => {
    const sources = dragSources(node);
    setDraggedNodes(sources);
    // Until a specific folder (or one of its files) is hovered, the tree root is the target.
    setDropTargetPath("");
    e.dataTransfer.effectAllowed = "move";
    const paths = sources.map((n) => n.path).join("\n");
    e.dataTransfer.setData(INTERNAL_DRAG_TYPE, paths);
    e.dataTransfer.setData("text/plain", paths);
    if (sources.length > 1) setCountDragImage(e, sources.length);
  };

  const onNodeDragEnd = () => {
    setDraggedNodes(null);
    setDropTargetPath(null);
  };

  /**
   * Moves the whole dragged batch with one request — a single drag is just a batch of one. The
   * server moves the items in order and stops at the first failure, so the results say exactly
   * which ones landed; everything here reconciles against those rather than assuming the batch
   * succeeded whole.
   */
  const moveNodes = async (
    sources: DraggedTreeNode[],
    destinationDirectory: string | null,
  ) => {
    setDraggedNodes(null);
    setDropTargetPath(null);
    setMovingPaths(new Set(sources.map((n) => n.path)));
    // Only the source containing the open file (if any) latches a pending move, so telling the
    // viewer about all of them up front is safe and keeps it from closing on the watcher's
    // source-deletion event.
    for (const source of sources) onMoveStarted?.(source.path);

    try {
      const outcome = await handleMoveMany(sources.map((n) => n.path), destinationDirectory);
      const results = outcome?.results ?? [];
      const moved = results.filter((r) => !r.unchanged);

      for (const result of moved) {
        remapSelection(result.sourcePath, result.path);
        onMovedPath?.(result.sourcePath, result.path);
      }
      // Anything the server did not move stays where it is: an unchanged item, and every item the
      // batch never reached once it stopped.
      const settled = new Set(moved.map((r) => r.sourcePath));
      for (const source of sources) {
        if (!settled.has(source.path)) onMoveCancelled?.(source.path);
      }

      if (moved.length > 0) {
        setExpanded((current) => {
          const remapped: Record<string, boolean> = {};
          for (const [path, isOpen] of Object.entries(current)) {
            // Sources are disjoint siblings, so at most one remap can apply to any given path.
            let next = path;
            for (const result of moved) next = remapMovedPath(next, result.sourcePath, result.path) ?? next;
            remapped[next] = isOpen;
          }
          if (destinationDirectory) remapped[destinationDirectory] = true;
          return remapped;
        });
      }

      // handleMoveMany surfaces why it stopped; this says how much of the batch landed.
      if (sources.length > 1 && (outcome === null || outcome.error)) {
        setMoveNote(`Moved ${moved.length} of ${sources.length} items`);
      }
    } finally {
      setMovingPaths(new Set());
    }
  };

  return (
    <aside
      className="relative flex flex-col bg-bg-tint overflow-hidden"
      style={style}
      onDragOver={onDragOver}
      onDragEnter={onDragEnter}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <div className="flex items-center gap-2 p-[14px_14px_8px]">
        <span className="font-semibold text-[15px] tracking-[-0.01em] whitespace-nowrap overflow-hidden text-ellipsis flex-1" title={workspaceName}>
          {workspaceName}
        </span>
      </div>

      <div className="flex gap-1.5 px-3 pb-2.5 border-b border-border">
        <UploadMenu
          status={upload.status} error={upload.error}
          uploadFiles={upload.uploadFiles} uploadFolder={upload.uploadFolder}
        />
      </div>

      <div
        className={`relative flex-1 overflow-auto py-2 transition-colors ${dropTargetPath === "" ? "bg-primary-tint" : ""}`}
        onDragOver={(e) => {
          if (!draggedNodes || e.target !== e.currentTarget) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = "move";
          setDropTargetPath("");
        }}
        onDragLeave={(e) => {
          if (e.target === e.currentTarget && dropTargetPath === "") setDropTargetPath(null);
        }}
        onDrop={(e) => {
          if (!draggedNodes || e.target !== e.currentTarget) return;
          e.preventDefault();
          void moveNodes(draggedNodes, null);
        }}
        title={draggedNodes ? "Drop on empty space to move to the root folder" : undefined}
      >
        <TreeNodeList
          nodes={tree} depth={0} parentDirectory={null}
          expanded={expanded} onToggle={toggleExpanded}
          activePath={selectedPath} selected={selected} onSelect={handleSelect}
          onRangeSelect={selectRangeTo}
          onPick={onFileSelect}
          draggedNodes={draggedNodes} dropTargetPath={dropTargetPath}
          movingPaths={movingPaths} onNodeDragStart={onNodeDragStart}
          onNodeDragEnd={onNodeDragEnd} onDropTargetChange={setDropTargetPath}
          onMove={(destinationDirectory) => {
            if (draggedNodes) void moveNodes(draggedNodes, destinationDirectory);
          }}
        />
        {dragging && (
          <div className={`absolute inset-0 z-10 flex items-center justify-center pointer-events-none border-2 border-dashed ${busy ? "border-border bg-bg/80" : "border-primary bg-primary-tint/80"}`}>
            <div className={`flex flex-col items-center gap-2 text-[13.5px] font-medium ${busy ? "text-text-3" : "text-primary"}`}>
              <UploadIcon />
              <span>{busy ? "Upload in progress — please wait" : "Drop files or folders to upload"}</span>
            </div>
          </div>
        )}
      </div>

      {(selected.size > 0 || deleteError || moveError || moveNote || movingPaths.size > 0) && (
        <div className="border-t border-border p-[10px_12px] bg-bg">
          <div className="flex gap-1">
            <button
              className="btn btn-ghost btn-sm flex-1 justify-center whitespace-nowrap items-center gap-1.5 disabled:opacity-60 disabled:cursor-wait"
              onClick={handleDownload}
              disabled={downloading || movingPaths.size > 0}
            >
              {downloading && (
                <span className="shrink-0 block w-3 h-3 border-2 border-current border-t-transparent rounded-full animate-spin" />
              )}
              {downloading ? "Zipping…" : "Download .zip"}
            </button>
            <button
              className="btn btn-ghost btn-sm flex-1 justify-center text-danger"
              onClick={handleDelete}
              disabled={downloading || movingPaths.size > 0}
            >
              Delete
            </button>
          </div>
          {deleteError && (
            <div className="text-xs text-danger whitespace-pre-wrap mt-2 px-1">{deleteError}</div>
          )}
          {movingPaths.size > 0 && (
            <div className="text-xs text-text-3 mt-2 px-1">
              {movingPaths.size > 1 ? `Moving ${movingPaths.size} items…` : "Moving…"}
            </div>
          )}
          {moveError && (
            <div className="text-xs text-danger whitespace-pre-wrap mt-2 px-1">{moveError}</div>
          )}
          {moveNote && <div className="text-xs text-text-3 mt-2 px-1">{moveNote}</div>}
        </div>
      )}
    </aside>
  );
}
