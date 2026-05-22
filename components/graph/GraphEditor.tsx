"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ReactFlow,
  Node,
  Edge,
  addEdge,
  useNodesState,
  useEdgesState,
  Background,
  BackgroundVariant,
  Controls,
  MarkerType,
  Connection,
  Handle,
  Position,
  NodeProps,
  OnEdgesChange,
  EdgeChange,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useRouter } from "next/navigation";
import TopBar from "@/components/layout/TopBar";

function loadDesc(id: string): string {
  try {
    return localStorage.getItem(`ws-desc-${id}`) ?? "";
  } catch {
    return "";
  }
}

function WorkspaceNode({ data, selected }: NodeProps) {
  const label = data.label as string;
  const description = data.description as string;
  return (
    <div className={"graph-node" + (selected ? " is-selected" : "")}>
      <Handle type="target" position={Position.Top} className="graph-handle" />
      <div className="graph-node-name">{label}</div>
      {description && <div className="graph-node-desc">{description}</div>}
      <Handle type="source" position={Position.Bottom} className="graph-handle" />
    </div>
  );
}

interface WorkspaceItem {
  id: string;
  name: string;
}

const EDGE_STYLE = {
  style: { stroke: "var(--text-3)", strokeWidth: 1.5 },
  markerEnd: { type: MarkerType.ArrowClosed, color: "var(--text-3)" },
};

function wouldCreateCycle(edges: Edge[], source: string, target: string): boolean {
  const adj = new Map<string, string[]>();
  for (const e of edges) {
    if (!adj.has(e.source)) adj.set(e.source, []);
    adj.get(e.source)!.push(e.target);
  }
  const visited = new Set<string>();
  const queue = [target];
  while (queue.length) {
    const node = queue.shift()!;
    if (node === source) return true;
    if (visited.has(node)) continue;
    visited.add(node);
    for (const n of adj.get(node) ?? []) queue.push(n);
  }
  return false;
}

export default function GraphEditor() {
  const router = useRouter();
  const nodeTypes = useMemo(() => ({ workspace: WorkspaceNode }), []);
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [isDirty, setIsDirty] = useState(false);
  const [showUnsavedModal, setShowUnsavedModal] = useState(false);
  const nodesRef = useRef<Node[]>([]);
  const edgesRef = useRef<Edge[]>([]);
  const errorTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => { nodesRef.current = nodes; }, [nodes]);
  useEffect(() => { edgesRef.current = edges; }, [edges]);

  useEffect(() => {
    Promise.all([
      fetch("/api/workspaces").then((r) => r.json()) as Promise<WorkspaceItem[]>,
      fetch("/api/workspace-graph").then((r) => r.json()) as Promise<{
        edges: Edge[];
        positions: Record<string, { x: number; y: number }>;
      }>,
    ])
      .then(([wss, graph]) => {
        const positions = graph.positions ?? {};
        setNodes(
          wss.map((ws, i) => ({
            id: ws.id,
            type: "workspace",
            position: positions[ws.id] ?? {
              x: 80 + (i % 3) * 260,
              y: 80 + Math.floor(i / 3) * 220,
            },
            data: { label: ws.name, description: loadDesc(ws.id) },
          }))
        );
        setEdges((graph.edges ?? []).map((e) => ({ ...e, ...EDGE_STYLE })));
        setReady(true);
      })
      .catch(() => setReady(true));
  }, [setNodes, setEdges]);

  // Warn on browser refresh / tab close
  useEffect(() => {
    const handler = (e: BeforeUnloadEvent) => {
      if (!isDirty) return;
      e.preventDefault();
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [isDirty]);

  const showError = useCallback((msg: string) => {
    setError(msg);
    if (errorTimer.current) clearTimeout(errorTimer.current);
    errorTimer.current = setTimeout(() => setError(null), 3000);
  }, []);

  const onConnect = useCallback(
    (connection: Connection) => {
      if (!connection.source || !connection.target) return;
      if (connection.source === connection.target) {
        showError("An agent cannot call itself.");
        return;
      }
      if (wouldCreateCycle(edgesRef.current, connection.source, connection.target)) {
        showError("Loop detected — agents cannot call back up the chain.");
        return;
      }
      setEdges((eds) => addEdge({ ...connection, ...EDGE_STYLE }, eds));
      setIsDirty(true);
    },
    [setEdges, showError]
  );

  // Only mark dirty on structural edge changes (add/remove), not selection
  const handleEdgesChange: OnEdgesChange = useCallback(
    (changes: EdgeChange[]) => {
      onEdgesChange(changes);
      if (changes.some((c) => c.type === "remove")) setIsDirty(true);
    },
    [onEdgesChange]
  );

  const onNodeDragStop = useCallback(() => {
    setIsDirty(true);
  }, []);

  const persist = useCallback(async () => {
    const positions: Record<string, { x: number; y: number }> = {};
    nodesRef.current.forEach((n) => { positions[n.id] = n.position; });
    await fetch("/api/workspace-graph", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ edges: edgesRef.current, positions }),
    });
  }, []);

  const handleSave = useCallback(async () => {
    await persist();
    setIsDirty(false);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  }, [persist]);

  const handleBack = useCallback(() => {
    if (isDirty) {
      setShowUnsavedModal(true);
    } else {
      router.push("/");
    }
  }, [isDirty, router]);

  const handleSaveAndLeave = useCallback(async () => {
    await persist();
    router.push("/");
  }, [persist, router]);

  return (
    <div className="graph-editor">
      <TopBar
        error={error}
        left={
          <>
            <button className="iconbtn" onClick={handleBack} title="Back to workspaces">
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                <path d="M10 3L5 8l5 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
            <span className="topbar-title">Agent Network</span>
            {isDirty && <span className="topbar-dirty">Unsaved changes</span>}
            <span className="topbar-hint">
              Drag bottom → top handle to connect · Backspace to remove selected edge
            </span>
          </>
        }
        right={
          <button className="btn btn-primary btn-sm" onClick={handleSave} disabled={!isDirty}>
            {saved ? "Saved ✓" : "Save"}
          </button>
        }
      />

      <div className="graph-canvas">
        {ready && (
          <ReactFlow
            nodes={nodes}
            edges={edges}
            onNodesChange={onNodesChange}
            onEdgesChange={handleEdgesChange}
            onConnect={onConnect}
            onNodeDragStop={onNodeDragStop}
            nodeTypes={nodeTypes}
            fitView
            fitViewOptions={{ padding: 0.3, maxZoom: 1 }}
            deleteKeyCode={["Backspace", "Delete"]}
            multiSelectionKeyCode="Shift"
          >
            <Background variant={BackgroundVariant.Dots} color="var(--border)" gap={24} size={1.2} />
            <Controls />
          </ReactFlow>
        )}
        {!ready && <div className="graph-loading">Loading workspaces…</div>}
      </div>

      {showUnsavedModal && (
        <div className="modal-overlay">
          <div className="modal">
            <div className="modal-title">Unsaved changes</div>
            <p className="modal-body">You have unsaved changes to the agent network. What would you like to do?</p>
            <div className="modal-actions">
              <button className="btn btn-primary" onClick={handleSaveAndLeave}>Save &amp; leave</button>
              <button className="btn" onClick={() => router.push("/")}>Leave without saving</button>
              <button className="linkbtn" onClick={() => setShowUnsavedModal(false)}>Cancel</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
