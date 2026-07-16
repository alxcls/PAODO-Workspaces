import type { DragEvent, MouseEvent } from "react";
import { canMoveAllToDirectory } from "@/lib/client/fileMove";
import { pathWithDescendants, sortTreeNodes } from "@/lib/client/fileTreeOrder";
import type { DraggedTreeNode } from "@/lib/client/hooks/useFileTreeMove";
import type { TreeNode } from "@/lib/client/hooks/useFileOperations";

type CheckState = "none" | "some" | "all";

interface SelectionBindings {
  activePath: string | null;
  selected: Set<string>;
  select: (paths: string[], on: boolean) => void;
  selectRange: (path: string) => void;
  pick: (path: string) => void;
}

interface MoveBindings {
  draggedNodes: DraggedTreeNode[] | null;
  dropTargetPath: string | null;
  movingPaths: Set<string>;
  dragStart: (node: TreeNode, event: DragEvent) => void;
  dragEnd: () => void;
  setDropTarget: (path: string | null) => void;
  moveTo: (destinationDirectory: string | null) => void;
}

interface Props {
  nodes: TreeNode[];
  depth?: number;
  parentDirectory?: string | null;
  expanded: Record<string, boolean>;
  toggleExpanded: (path: string) => void;
  selection: SelectionBindings;
  move: MoveBindings;
}

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

const Checkbox = ({ state, onClick }: { state: CheckState; onClick: (event: MouseEvent) => void }) => (
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

function nodeCheckState(node: TreeNode, selected: Set<string>): CheckState {
  if (selected.has(node.path)) return "all";
  if (node.type === "file") return "none";
  const hasSelectedDescendant = (node.children ?? []).some((child) =>
    nodeCheckState(child, selected) !== "none");
  return hasSelectedDescendant ? "some" : "none";
}

function dropZoneHandlers({
  targetKey,
  destination,
  canDrop,
  move,
}: {
  targetKey: string;
  destination: string | null;
  canDrop: boolean;
  move: MoveBindings;
}) {
  return {
    onDragOver: (event: DragEvent) => {
      if (!move.draggedNodes) return;
      event.preventDefault();
      event.stopPropagation();
      event.dataTransfer.dropEffect = canDrop ? "move" : "none";
      move.setDropTarget(canDrop ? targetKey : null);
    },
    onDragLeave: (event: DragEvent) => {
      if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
      if (move.dropTargetPath === targetKey) move.setDropTarget(null);
    },
    onDrop: (event: DragEvent) => {
      if (!move.draggedNodes) return;
      event.preventDefault();
      event.stopPropagation();
      move.setDropTarget(null);
      if (canDrop) move.moveTo(destination);
    },
  };
}

/** Recursive, presentational rendering for file-tree rows and their drop zones. */
export function FileTreeList({
  nodes,
  depth = 0,
  parentDirectory = null,
  expanded,
  toggleExpanded,
  selection,
  move,
}: Props) {
  return (
    <>
      {sortTreeNodes(nodes).map((node) => {
        if (node.type === "directory") {
          const isOpen = expanded[node.path] ?? false;
          const checkState = nodeCheckState(node, selection.selected);
          const canDrop = move.draggedNodes
            ? canMoveAllToDirectory(move.draggedNodes, node.path)
            : false;
          const isDropTarget = canDrop && move.dropTargetPath === node.path;

          return (
            <div key={node.path} className={isDropTarget ? "bg-primary-tint" : ""}>
              <button
                className={`flex items-center w-full border-0 border-l-[3px] bg-transparent py-[5px] pl-2 pr-2 text-[13.5px] text-text cursor-pointer text-left transition-[background,border-color,color,opacity] duration-[120ms] hover:bg-black/[.04]
                  ${isDropTarget ? "bg-primary-tint border-l-primary" : "border-l-transparent"}
                  ${checkState !== "none" ? "bg-select-tint" : ""}
                  ${move.movingPaths.has(node.path) ? "opacity-50" : ""}`}
                onClick={(event) => {
                  if (event.shiftKey) selection.selectRange(node.path);
                  else toggleExpanded(node.path);
                }}
                draggable={move.movingPaths.size === 0}
                onDragStart={(event) => move.dragStart(node, event)}
                onDragEnd={move.dragEnd}
                {...dropZoneHandlers({
                  targetKey: node.path,
                  destination: node.path,
                  canDrop,
                  move,
                })}
              >
                <Checkbox
                  state={checkState}
                  onClick={(event) => {
                    event.stopPropagation();
                    if (event.shiftKey) selection.selectRange(node.path);
                    else selection.select(pathWithDescendants(node), checkState === "none");
                  }}
                />
                <div className="flex items-center gap-1.5 flex-1 min-w-0 overflow-hidden" style={{ marginLeft: 6 + depth * 14 }}>
                  <span className={`inline-flex items-center justify-center w-3 h-3 flex-shrink-0 transition-transform duration-[150ms] text-text-3 ${isOpen ? "rotate-90" : ""}`}>
                    <ChevIcon />
                  </span>
                  <span className="text-text-2 inline-flex flex-shrink-0"><FolderIcon /></span>
                  <span className="flex-1 whitespace-nowrap overflow-hidden text-ellipsis">{node.name}</span>
                </div>
              </button>
              {isOpen && node.children && (
                <FileTreeList
                  nodes={node.children}
                  depth={depth + 1}
                  parentDirectory={node.path}
                  expanded={expanded}
                  toggleExpanded={toggleExpanded}
                  selection={selection}
                  move={move}
                />
              )}
            </div>
          );
        }

        const isActive = node.path === selection.activePath;
        const isSelected = selection.selected.has(node.path);
        const canDrop = move.draggedNodes && parentDirectory !== null
          ? canMoveAllToDirectory(move.draggedNodes, parentDirectory)
          : move.draggedNodes !== null;

        return (
          <button
            key={node.path}
            className={`flex items-center w-full border-0 border-l-[3px] bg-transparent py-[5px] pl-2 pr-2 text-[13.5px] cursor-pointer text-left transition-[background,border-color,color] duration-[120ms]
              ${isActive
                ? "bg-primary-tint border-l-primary text-primary"
                : `border-l-transparent text-text hover:bg-black/[.04] ${isSelected ? "bg-select-tint" : ""}`
              }
              ${move.movingPaths.has(node.path) ? "opacity-50" : ""}`}
            onClick={(event) => {
              if (event.shiftKey) selection.selectRange(node.path);
              else selection.pick(node.path);
            }}
            draggable={move.movingPaths.size === 0}
            onDragStart={(event) => move.dragStart(node, event)}
            onDragEnd={move.dragEnd}
            {...dropZoneHandlers({
              targetKey: parentDirectory ?? "",
              destination: parentDirectory,
              canDrop,
              move,
            })}
          >
            <Checkbox
              state={isSelected ? "all" : "none"}
              onClick={(event) => {
                event.stopPropagation();
                if (event.shiftKey) selection.selectRange(node.path);
                else selection.select([node.path], !isSelected);
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
}
