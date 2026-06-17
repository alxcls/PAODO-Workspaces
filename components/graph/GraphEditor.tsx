"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ReactFlow, Node, Edge, addEdge, useNodesState, useEdgesState,
  Background, BackgroundVariant, Controls, MarkerType, Connection,
  Handle, Position, NodeProps, OnEdgesChange, EdgeChange,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useRouter } from "next/navigation";
import Image from "next/image";
import TopBar from "@/components/layout/TopBar";

function loadDesc(id: string): string {
  try { return localStorage.getItem(`ws-desc-${id}`) ?? ""; } catch { return ""; }
}

function WorkspaceNode({ data, selected }: NodeProps) {
  const label = data.label as string;
  const description = data.description as string;
  return (
    <div className={`bg-white border rounded-card p-[12px_14px_16px] min-w-[160px] max-w-[220px] shadow-sm cursor-default transition-[border-color,box-shadow] duration-[140ms] hover:border-primary-2 ${selected ? "border-primary shadow-[0_0_0_2px_var(--color-primary-soft),var(--shadow-sm)]" : "border-border"}`}>
      <Handle type="target" position={Position.Top} className="graph-handle" />
      <div className="font-semibold text-ms text-text whitespace-nowrap overflow-hidden text-ellipsis">{label}</div>
      {description && (
        <div className="text-xs text-text-2 mt-1 leading-[1.4] whitespace-pre-wrap">{description}</div>
      )}
      <Handle type="source" position={Position.Bottom} className="graph-handle" />
    </div>
  );
}

interface WorkspaceItem { id: string; name: string; }

const EDGE_STYLE = {
  style: { stroke: "var(--color-text-3)", strokeWidth: 1.5 },
  markerEnd: { type: MarkerType.ArrowClosed, color: "var(--color-text-3)" },
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
      fetch("/api/workspace-graph").then((r) => {
        if (!r.ok) throw new Error("graph-disabled");
        return r.json() as Promise<{ edges: Edge[]; positions: Record<string, { x: number; y: number }> }>;
      }),
    ])
      .then(([wss, graph]) => {
        const positions = graph.positions ?? {};
        setNodes(wss.map((ws, i) => ({
          id: ws.id, type: "workspace",
          position: positions[ws.id] ?? { x: 80 + (i % 3) * 260, y: 80 + Math.floor(i / 3) * 220 },
          data: { label: ws.name, description: loadDesc(ws.id) },
        })));
        setEdges((graph.edges ?? []).map((e) => ({ ...e, ...EDGE_STYLE })));
        setReady(true);
      })
      .catch((e: unknown) => {
        if (e instanceof Error && e.message === "graph-disabled") {
          router.replace("/");
        } else {
          setReady(true);
        }
      });
  }, [setNodes, setEdges, router]);

  useEffect(() => {
    const handler = (e: BeforeUnloadEvent) => { if (!isDirty) return; e.preventDefault(); };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [isDirty]);

  const showError = useCallback((msg: string) => {
    setError(msg);
    if (errorTimer.current) clearTimeout(errorTimer.current);
    errorTimer.current = setTimeout(() => setError(null), 3000);
  }, []);

  const onConnect = useCallback((connection: Connection) => {
    if (!connection.source || !connection.target) return;
    if (connection.source === connection.target) { showError("An agent cannot call itself."); return; }
    if (wouldCreateCycle(edgesRef.current, connection.source, connection.target)) {
      showError("Loop detected — agents cannot call back up the chain."); return;
    }
    setEdges((eds) => addEdge({ ...connection, ...EDGE_STYLE }, eds));
    setIsDirty(true);
  }, [setEdges, showError]);

  const handleEdgesChange: OnEdgesChange = useCallback((changes: EdgeChange[]) => {
    onEdgesChange(changes);
    if (changes.some((c) => c.type === "remove")) setIsDirty(true);
  }, [onEdgesChange]);

  const onNodeDragStop = useCallback(() => { setIsDirty(true); }, []);

  const persist = useCallback(async () => {
    const positions: Record<string, { x: number; y: number }> = {};
    nodesRef.current.forEach((n) => { positions[n.id] = n.position; });
    const res = await fetch("/api/workspace-graph", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ edges: edgesRef.current, positions }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({})) as { error?: string };
      throw new Error(body.error ?? `Save failed (${res.status})`);
    }
  }, []);

  const handleSave = useCallback(async () => {
    try {
      await persist(); setIsDirty(false); setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (err) {
      showError(err instanceof Error ? err.message : "Save failed");
    }
  }, [persist, showError]);

  const handleBack = useCallback(() => {
    if (isDirty) setShowUnsavedModal(true);
    else router.push("/");
  }, [isDirty, router]);

  const handleSaveAndLeave = useCallback(async () => {
    try {
      await persist(); router.push("/");
    } catch (err) {
      showError(err instanceof Error ? err.message : "Save failed");
    }
  }, [persist, router, showError]);

  return (
    <div className="h-screen flex flex-col bg-bg-tint">
      <TopBar
        error={error}
        left={
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleBack}
              title="Back to workspaces"
              className="w-[34px] h-[34px] rounded-[10px] overflow-hidden flex-shrink-0 inline-flex items-center justify-center bg-gradient-to-br from-primary to-primary-2 border-0 p-0 cursor-pointer"
            >
              <Image src="/paodo-logo.svg" alt="Paodo logo" width={34} height={34} className="block w-full h-full object-cover" unoptimized />
            </button>
            <span className="font-semibold tracking-[-0.01em] text-lg leading-none inline-flex items-center">
              PAODO WS agents
            </span>
          </div>
        }
        right={
          <div className="flex items-center gap-2.5">
            {isDirty && <span className="text-xs text-text-3 italic">Unsaved changes</span>}
            <button className="btn btn-primary btn-sm" onClick={handleSave} disabled={!isDirty}>
              {saved ? "Saved ✓" : "Save"}
            </button>
          </div>
        }
      />

      <div className="flex-1 min-h-0 relative">
        {ready && (
          <ReactFlow
            nodes={nodes} edges={edges}
            onNodesChange={onNodesChange} onEdgesChange={handleEdgesChange}
            onConnect={onConnect} onNodeDragStop={onNodeDragStop}
            nodeTypes={nodeTypes} fitView fitViewOptions={{ padding: 0.3, maxZoom: 1 }}
            deleteKeyCode={["Backspace", "Delete"]} multiSelectionKeyCode="Shift"
          >
            <Background variant={BackgroundVariant.Dots} color="var(--color-border)" gap={24} size={1.2} />
            <Controls />
          </ReactFlow>
        )}
        {!ready && (
          <div className="absolute inset-0 flex items-center justify-center text-text-3 text-sm">
            Loading workspaces…
          </div>
        )}
      </div>

      {showUnsavedModal && (
        <div className="fixed inset-0 bg-[rgba(15,10,30,0.55)] flex items-center justify-center z-[1000]">
          <div className="bg-white rounded-2xl shadow-[0_18px_40px_rgba(15,10,30,0.25)] p-[30px_34px] w-[min(460px,calc(100vw-48px))] border border-[rgba(15,10,30,0.08)]">
            <div className="font-semibold text-[19px] mb-3 text-text">Unsaved changes</div>
            <p className="text-sm text-text-2 m-0 mb-[26px] leading-[1.5]">
              You have unsaved changes to the agent network. What would you like to do?
            </p>
            <div className="flex gap-2.5 items-center flex-wrap">
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
