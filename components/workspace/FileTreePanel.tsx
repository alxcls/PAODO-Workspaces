"use client";

import { useRef, useState } from "react";
import { useFileTreeSelection } from "@/lib/client/hooks/useFileTreeSelection";
import { useFileOperations, TreeNode } from "@/lib/client/hooks/useFileOperations";
import { useFileUpload } from "@/lib/client/hooks/useFileUpload";
import { readDroppedEntries } from "@/lib/client/dropEntries";
import { canMoveToDirectory, remapMovedPath } from "@/lib/client/fileMove";

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
function getAllNodes(nodes: TreeNode[]): TreeNode[] {
  return nodes.flatMap((n) => [n, ...getAllNodes(n.children ?? [])]);
}

function getNodeCheckState(node: TreeNode, selected: Set<string>): CheckState {
  if (selected.has(node.path)) return "all";
  if (node.type === "file") return "none";
  const anyDescendant = getAllNodes(node.children ?? []).some((n) => selected.has(n.path));
  return anyDescendant ? "some" : "none";
}

// ---- Checkbox ----
const Checkbox = ({ state, onClick }: { state: CheckState; onClick: (e: React.MouseEvent) => void }) => (
  <span
    className={`w-[14px] h-[14px] rounded-[3px] inline-flex items-center justify-center flex-shrink-0 transition-[border-color,background] duration-[120ms] border-[1.4px] cursor-pointer
      ${state !== "none" ? "bg-select border-select text-white" : "bg-white border-border hover:border-select"}`}
    onClick={onClick}
    role="checkbox"
    aria-checked={state === "all" ? "true" : state === "some" ? "mixed" : "false"}
  >
    {state === "all" && (
      <svg viewBox="0 0 16 16" width="10" height="10" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
        <polyline points="3 9 6.5 12.5 13 4" />
      </svg>
    )}
    {state === "some" && (
      <svg viewBox="0 0 16 16" width="10" height="10" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
        <line x1="4" y1="8" x2="12" y2="8" />
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
  onPick: (path: string) => void;
  draggedNode: DraggedTreeNode | null; dropTargetPath: string | null;
  movingPath: string | null;
  onNodeDragStart: (node: TreeNode, e: React.DragEvent) => void;
  onNodeDragEnd: () => void;
  onDropTargetChange: (path: string | null) => void;
  onMove: (sourcePath: string, destinationDirectory: string | null) => void;
}

const TreeNodeList = ({
  nodes, depth, parentDirectory, expanded, onToggle, activePath, selected, onSelect, onPick,
  draggedNode, dropTargetPath, movingPath,
  onNodeDragStart, onNodeDragEnd, onDropTargetChange, onMove,
}: TreeListProps) => {
  const sorted = [...nodes].sort((a, b) => {
    if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  return (
    <>
      {sorted.map((node) => {
        if (node.type === "directory") {
          const isOpen = expanded[node.path] ?? false;
          const state = getNodeCheckState(node, selected);
          const canDrop = draggedNode ? canMoveToDirectory(draggedNode, node.path) : false;
          const isDropTarget = canDrop && dropTargetPath === node.path;
          return (
            <div key={node.path} className={isDropTarget ? "bg-primary-tint" : ""}>
              <button
                className={`flex items-center w-full border-0 border-l-[3px] bg-transparent py-[5px] pl-2 pr-2 text-[13.5px] text-text cursor-pointer text-left transition-[background,border-color,color,opacity] duration-[120ms] hover:bg-black/[.04]
                  ${isDropTarget ? "bg-primary-tint border-l-primary" : "border-l-transparent"}
                  ${state !== "none" ? "bg-select-tint" : ""}
                  ${movingPath === node.path ? "opacity-50" : ""}`}
                onClick={() => onToggle(node.path)}
                draggable={movingPath === null}
                onDragStart={(e) => onNodeDragStart(node, e)}
                onDragEnd={onNodeDragEnd}
                onDragOver={(e) => {
                  if (!draggedNode) return;
                  e.preventDefault();
                  e.stopPropagation();
                  e.dataTransfer.dropEffect = canDrop ? "move" : "none";
                  onDropTargetChange(canDrop ? node.path : null);
                }}
                onDragLeave={(e) => {
                  if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
                  if (dropTargetPath === node.path) onDropTargetChange(null);
                }}
                onDrop={(e) => {
                  if (!draggedNode) return;
                  e.preventDefault();
                  e.stopPropagation();
                  onDropTargetChange(null);
                  if (canDrop) onMove(draggedNode.path, node.path);
                }}
              >
                <Checkbox state={state} onClick={(e) => {
                  e.stopPropagation();
                  // Selecting/deselecting a folder cascades to every descendant so child
                  // folders and files reflect (and are included in) the selection.
                  const descendants = getAllNodes(node.children ?? []).map((n) => n.path);
                  onSelect([node.path, ...descendants], state === "none");
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
                  onSelect={onSelect} onPick={onPick}
                  draggedNode={draggedNode} dropTargetPath={dropTargetPath}
                  movingPath={movingPath} onNodeDragStart={onNodeDragStart}
                  onNodeDragEnd={onNodeDragEnd} onDropTargetChange={onDropTargetChange}
                  onMove={onMove}
                />
              )}
            </div>
          );
        }

        const isActive = node.path === activePath;
        const isSel = selected.has(node.path);
        const canDropBesideFile = draggedNode && parentDirectory !== null
          ? canMoveToDirectory(draggedNode, parentDirectory)
          : Boolean(draggedNode);
        return (
          <button
            key={node.path}
            className={`flex items-center w-full border-0 border-l-[3px] bg-transparent py-[5px] pl-2 pr-2 text-[13.5px] cursor-pointer text-left transition-[background,border-color,color] duration-[120ms]
              ${isActive
                ? "bg-primary-tint border-l-primary text-primary"
                : `border-l-transparent text-text hover:bg-black/[.04] ${isSel ? "bg-select-tint" : ""}`
              }`}
            onClick={() => onPick(node.path)}
            draggable={movingPath === null}
            onDragStart={(e) => onNodeDragStart(node, e)}
            onDragEnd={onNodeDragEnd}
            onDragOver={(e) => {
              if (!draggedNode) return;
              e.preventDefault();
              e.stopPropagation();
              e.dataTransfer.dropEffect = canDropBesideFile ? "move" : "none";
              onDropTargetChange(canDropBesideFile ? (parentDirectory ?? "") : null);
            }}
            onDragLeave={() => {
              if (dropTargetPath === (parentDirectory ?? "")) onDropTargetChange(null);
            }}
            onDrop={(e) => {
              if (!draggedNode) return;
              e.preventDefault();
              e.stopPropagation();
              onDropTargetChange(null);
              if (canDropBesideFile) onMove(draggedNode.path, parentDirectory);
            }}
          >
            <Checkbox
              state={isSel ? "all" : "none"}
              onClick={(e) => { e.stopPropagation(); onSelect([node.path], !isSel); }}
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
  const [draggedNode, setDraggedNode] = useState<DraggedTreeNode | null>(null);
  // "" is the tree root, null is no target at all — a hover the drop would reject must use null,
  // or the root lights up as though it were about to receive the item.
  const [dropTargetPath, setDropTargetPath] = useState<string | null>(null);
  const base = apiBase ?? `/api/workspaces/${workspaceId}`;

  const { selected, handleSelect, clearSelection, remapSelection } = useFileTreeSelection();
  const {
    tree, fetchTree, handleDownload, downloading, handleDelete, deleteError,
    handleMove, movingPath, moveError,
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

  const onNodeDragStart = (node: TreeNode, e: React.DragEvent) => {
    const dragged = { name: node.name, path: node.path, type: node.type };
    setDraggedNode(dragged);
    // Until a specific folder (or one of its files) is hovered, the tree root is the target.
    setDropTargetPath("");
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData(INTERNAL_DRAG_TYPE, node.path);
    e.dataTransfer.setData("text/plain", node.path);
  };

  const onNodeDragEnd = () => {
    setDraggedNode(null);
    setDropTargetPath(null);
  };

  const moveNode = async (sourcePath: string, destinationDirectory: string | null) => {
    onMoveStarted?.(sourcePath);
    const moved = await handleMove(sourcePath, destinationDirectory);
    setDraggedNode(null);
    setDropTargetPath(null);
    if (!moved || moved.unchanged) {
      onMoveCancelled?.(sourcePath);
      return;
    }
    const destinationPath = moved.path;

    remapSelection(sourcePath, destinationPath);
    setExpanded((current) => {
      const remapped: Record<string, boolean> = {};
      for (const [path, isOpen] of Object.entries(current)) {
        remapped[remapMovedPath(path, sourcePath, destinationPath) ?? path] = isOpen;
      }
      if (destinationDirectory) remapped[destinationDirectory] = true;
      return remapped;
    });
    onMovedPath?.(sourcePath, destinationPath);
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
          if (!draggedNode || e.target !== e.currentTarget) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = "move";
          setDropTargetPath("");
        }}
        onDragLeave={(e) => {
          if (e.target === e.currentTarget && dropTargetPath === "") setDropTargetPath(null);
        }}
        onDrop={(e) => {
          if (!draggedNode || e.target !== e.currentTarget) return;
          e.preventDefault();
          void moveNode(draggedNode.path, null);
        }}
        title={draggedNode ? "Drop on empty space to move to the root folder" : undefined}
      >
        <TreeNodeList
          nodes={tree} depth={0} parentDirectory={null}
          expanded={expanded} onToggle={toggleExpanded}
          activePath={selectedPath} selected={selected} onSelect={handleSelect}
          onPick={onFileSelect}
          draggedNode={draggedNode} dropTargetPath={dropTargetPath}
          movingPath={movingPath} onNodeDragStart={onNodeDragStart}
          onNodeDragEnd={onNodeDragEnd} onDropTargetChange={setDropTargetPath}
          onMove={(sourcePath, destinationDirectory) => { void moveNode(sourcePath, destinationDirectory); }}
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

      {(selected.size > 0 || deleteError || moveError || movingPath) && (
        <div className="border-t border-border p-[10px_12px] bg-bg">
          <div className="flex gap-1">
            <button
              className="btn btn-ghost btn-sm flex-1 justify-center whitespace-nowrap items-center gap-1.5 disabled:opacity-60 disabled:cursor-wait"
              onClick={handleDownload}
              disabled={downloading}
            >
              {downloading && (
                <span className="shrink-0 block w-3 h-3 border-2 border-current border-t-transparent rounded-full animate-spin" />
              )}
              {downloading ? "Zipping…" : "Download .zip"}
            </button>
            <button className="btn btn-ghost btn-sm flex-1 justify-center text-danger" onClick={handleDelete} disabled={downloading}>
              Delete
            </button>
          </div>
          {deleteError && (
            <div className="text-xs text-danger whitespace-pre-wrap mt-2 px-1">{deleteError}</div>
          )}
          {movingPath && <div className="text-xs text-text-3 mt-2 px-1">Moving…</div>}
          {moveError && (
            <div className="text-xs text-danger whitespace-pre-wrap mt-2 px-1">{moveError}</div>
          )}
        </div>
      )}
    </aside>
  );
}
