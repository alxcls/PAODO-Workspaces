import { useState, type Dispatch, type DragEvent, type SetStateAction } from "react";
import { collapseToRoots, remapMovedPath } from "../fileMove";
import { flattenTree } from "../fileTreeOrder";
import type { MoveBatchOutcome, TreeNode } from "./useFileOperations";
import { useTransientMessage } from "./useTransientMessage";

const INTERNAL_DRAG_TYPE = "application/x-paodo-tree-path";

export type DraggedTreeNode = Pick<TreeNode, "name" | "path" | "type">;

interface MoveLifecycle {
  started?: (sourcePath: string) => void;
  cancelled?: (sourcePath: string) => void;
  completed?: (sourcePath: string, destinationPath: string) => void;
}

interface Options {
  tree: TreeNode[];
  selected: Set<string>;
  setExpanded: Dispatch<SetStateAction<Record<string, boolean>>>;
  remapSelection: (sourceRoot: string, destinationRoot: string) => void;
  moveMany: (sourcePaths: string[], destinationDirectory: string | null) => Promise<MoveBatchOutcome | null>;
  lifecycle: MoveLifecycle;
}

function setCountDragImage(event: DragEvent, count: number) {
  const ghost = document.createElement("div");
  ghost.textContent = `${count} items`;
  ghost.style.cssText = [
    "position:fixed",
    "top:-1000px",
    "left:-1000px",
    "padding:4px 10px",
    "border-radius:6px",
    "white-space:nowrap",
    "background:#111827",
    "color:#fff",
    "font:500 12px system-ui,sans-serif",
  ].join(";");
  document.body.appendChild(ghost);
  event.dataTransfer.setDragImage(ghost, 12, 12);
  setTimeout(() => ghost.remove(), 0);
}

function remapExpandedPaths(
  expanded: Record<string, boolean>,
  moved: MoveBatchOutcome["results"],
  destinationDirectory: string | null,
): Record<string, boolean> {
  const remapped: Record<string, boolean> = {};
  for (const [path, isOpen] of Object.entries(expanded)) {
    let next = path;
    for (const result of moved) {
      next = remapMovedPath(next, result.sourcePath, result.path) ?? next;
    }
    remapped[next] = isOpen;
  }
  if (destinationDirectory) remapped[destinationDirectory] = true;
  return remapped;
}

/** Owns the complete internal tree-move interaction and its reconciliation lifecycle. */
export function useFileTreeMove({ tree, selected, setExpanded, remapSelection, moveMany, lifecycle }: Options) {
  const [draggedNodes, setDraggedNodes] = useState<DraggedTreeNode[] | null>(null);
  const [movingPaths, setMovingPaths] = useState<Set<string>>(new Set());
  const [dropTargetPath, setDropTargetPath] = useState<string | null>(null);
  const [moveNote, setMoveNote] = useTransientMessage(3500);

  const dragSources = (node: TreeNode): DraggedTreeNode[] => {
    const single = [{ name: node.name, path: node.path, type: node.type }];
    if (!selected.has(node.path) || selected.size <= 1) return single;

    const nodesByPath = new Map(flattenTree(tree).map((item) => [item.path, item]));
    const roots = collapseToRoots(Array.from(selected))
      .map((path) => nodesByPath.get(path))
      .filter((item): item is TreeNode => item !== undefined)
      .map(({ name, path, type }) => ({ name, path, type }));
    return roots.length > 0 ? roots : single;
  };

  const handleDragStart = (node: TreeNode, event: DragEvent) => {
    const sources = dragSources(node);
    setDraggedNodes(sources);
    setDropTargetPath("");
    event.dataTransfer.effectAllowed = "move";
    const paths = sources.map((source) => source.path).join("\n");
    event.dataTransfer.setData(INTERNAL_DRAG_TYPE, paths);
    event.dataTransfer.setData("text/plain", paths);
    if (sources.length > 1) setCountDragImage(event, sources.length);
  };

  const handleDragEnd = () => {
    setDraggedNodes(null);
    setDropTargetPath(null);
  };

  const moveTo = async (destinationDirectory: string | null) => {
    if (!draggedNodes) return;
    const sources = draggedNodes;
    setDraggedNodes(null);
    setDropTargetPath(null);
    setMovingPaths(new Set(sources.map((source) => source.path)));
    for (const source of sources) lifecycle.started?.(source.path);

    try {
      const outcome = await moveMany(
        sources.map((source) => source.path),
        destinationDirectory,
      );
      const moved = (outcome?.results ?? []).filter((result) => !result.unchanged);

      for (const result of moved) {
        remapSelection(result.sourcePath, result.path);
        lifecycle.completed?.(result.sourcePath, result.path);
      }

      const settled = new Set(moved.map((result) => result.sourcePath));
      for (const source of sources) {
        if (!settled.has(source.path)) lifecycle.cancelled?.(source.path);
      }

      if (moved.length > 0) {
        setExpanded((current) => remapExpandedPaths(current, moved, destinationDirectory));
      }
      if (sources.length > 1 && (outcome === null || outcome.error)) {
        setMoveNote(`Moved ${moved.length} of ${sources.length} items`);
      }
    } finally {
      setMovingPaths(new Set());
    }
  };

  return {
    draggedNodes,
    movingPaths,
    dropTargetPath,
    setDropTargetPath,
    moveNote,
    handleDragStart,
    handleDragEnd,
    moveTo,
  };
}
