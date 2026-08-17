"use client";

// The React Flow surface and the lattice it enforces. Everything here is canvas behaviour; the page
// chrome around it (toolbar, forms, prompts) lives in GraphEditor.
import { useMemo } from "react";
import {
  Background,
  BackgroundVariant,
  ConnectionMode,
  Controls,
  ReactFlow,
  type Edge,
  type Node,
  type OnConnect,
  type OnEdgesChange,
  type OnNodeDrag,
  type OnNodesChange,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { FloatingConnectionLine, FloatingEdge } from "./FloatingEdge";
import { DriveNode, WorkspaceNode } from "./GraphNodes";
import { SNAP_GRID } from "./grid";

interface GraphCanvasProps {
  nodes: Node[];
  edges: Edge[];
  onNodesChange: OnNodesChange<Node>;
  onEdgesChange: OnEdgesChange<Edge>;
  onConnect: OnConnect;
  onNodeDragStart: OnNodeDrag;
  onNodeDragStop: OnNodeDrag;
  onNodeDoubleClick(event: React.MouseEvent, node: Node): void;
}

export default function GraphCanvas(props: GraphCanvasProps) {
  const nodeTypes = useMemo(() => ({ workspace: WorkspaceNode, drive: DriveNode }), []);
  const edgeTypes = useMemo(() => ({ floating: FloatingEdge }), []);

  return (
    <ReactFlow
      {...props}
      connectionMode={ConnectionMode.Loose}
      connectionLineComponent={FloatingConnectionLine}
      nodeTypes={nodeTypes}
      edgeTypes={edgeTypes}
      fitView
      fitViewOptions={{ padding: 0.3, maxZoom: 1 }}
      nodeDragThreshold={4}
      deleteKeyCode={null}
      multiSelectionKeyCode="Shift"
      snapToGrid
      snapGrid={SNAP_GRID}
    >
      <Background variant={BackgroundVariant.Dots} color="var(--color-border)" gap={24} size={1.2} />
      <Controls />
    </ReactFlow>
  );
}
