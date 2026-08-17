"use client";

// Drag lifecycle for the cell lattice: remember where a drag started, and refuse a drop that would
// land on a cell another card already holds.
import { useCallback, useRef, type Dispatch, type SetStateAction } from "react";
import type { Node, OnNodeDrag } from "@xyflow/react";
import { findTakenCell, type PixelPosition } from "./grid";

/** React Flow reports a lone drag with an empty `nodes`, and a multi-selection drag with all of them. */
const draggedNodes = (node: Node, nodes: Node[]): Node[] => (nodes.length ? nodes : [node]);

interface PlacementOptions {
  getNodes(): Node[];
  setNodes: Dispatch<SetStateAction<Node[]>>;
  onMoved(): void;
}

export function useNodePlacement({ getNodes, setNodes, onMoved }: PlacementOptions) {
  const originsRef = useRef<Map<string, PixelPosition>>(new Map());

  const onNodeDragStart = useCallback<OnNodeDrag>((_, node, nodes) => {
    originsRef.current = new Map(draggedNodes(node, nodes).map((dragged) => [dragged.id, dragged.position]));
  }, []);

  // A cell holds one card, so a drop onto an occupied one has nowhere to go and snaps back to where
  // the drag started rather than stacking two cards in the same slot.
  const onNodeDragStop = useCallback<OnNodeDrag>(
    (_, node, nodes) => {
      if (!findTakenCell(draggedNodes(node, nodes), getNodes())) {
        onMoved();
        return;
      }
      const origins = originsRef.current;
      setNodes((current) =>
        current.map((candidate) => {
          const origin = origins.get(candidate.id);
          return origin ? { ...candidate, position: origin } : candidate;
        }),
      );
    },
    [getNodes, onMoved, setNodes],
  );

  return { onNodeDragStart, onNodeDragStop };
}
