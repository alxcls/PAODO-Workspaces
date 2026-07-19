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
  ConnectionMode,
  Handle,
  Position,
  NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useRouter } from "next/navigation";
import Image from "next/image";
import TopBar from "@/components/layout/TopBar";
import { FloatingEdge, FloatingConnectionLine } from "./FloatingEdge";

const WORKSPACE_TOP_HANDLE = "workspace-target-top";
const WORKSPACE_BOTTOM_HANDLE = "workspace-source-bottom";
const WORKSPACE_INCOMING_HANDLES = new Set([WORKSPACE_TOP_HANDLE, WORKSPACE_BOTTOM_HANDLE]);

function normalizeWorkspaceIncomingHandle(handle?: string | null): string {
  if (handle === "workspace-target-bottom") return WORKSPACE_BOTTOM_HANDLE;
  return handle && WORKSPACE_INCOMING_HANDLES.has(handle) ? handle : WORKSPACE_TOP_HANDLE;
}

// Shared card body for graph nodes so workspace and drive nodes look identical
// (icon + name + optional description). Handles are passed as children and absolutely
// positioned by React Flow against the card edges; the node types differ only in those.
function NodeCard({
  icon,
  label,
  description,
  selected,
  title,
  className = "",
  children,
}: {
  icon: React.ReactNode;
  label: string;
  description?: string;
  selected?: boolean;
  title?: string;
  className?: string;
  children?: React.ReactNode;
}) {
  const hasDescription = Boolean(description?.trim());
  return (
    <div
      title={title}
      className={`bg-white border rounded-card p-[12px_14px_16px] min-w-[220px] max-w-[280px] shadow-sm transition-[border-color,box-shadow] duration-[140ms] hover:border-primary-2 ${selected ? "border-primary shadow-[0_0_0_2px_var(--color-primary-soft),var(--shadow-sm)]" : "border-border"} ${className}`}
    >
      {children}
      <div className="flex gap-3 items-center">
        <div className="flex h-[34px] w-[34px] flex-shrink-0 items-center justify-center">{icon}</div>
        <div className="min-w-0 flex-1">
          <div className="font-semibold text-ms text-text whitespace-nowrap overflow-hidden text-ellipsis">{label}</div>
          {hasDescription && (
            <div className="text-xs text-text-2 mt-1 leading-[1.4] whitespace-pre-wrap">{description}</div>
          )}
        </div>
      </div>
    </div>
  );
}

function WorkspaceNode({ data, selected }: NodeProps) {
  return (
    <NodeCard
      icon={
        <Image
          src="/agent-robot.svg"
          alt="Workspace icon"
          width={34}
          height={34}
          className="h-[34px] w-[34px]"
          unoptimized
        />
      }
      label={data.label as string}
      description={data.description as string}
      selected={selected}
      title="Open workspace"
      className="cursor-pointer"
    >
      <Handle
        id="workspace-target-top"
        type="target"
        position={Position.Top}
        className="graph-handle"
        isConnectableStart={false}
      />
      <Handle
        id="workspace-source-bottom"
        type="source"
        position={Position.Bottom}
        className="graph-handle"
        isConnectableEnd
      />
    </NodeCard>
  );
}

const DriveIcon = () => (
  <svg viewBox="0 0 24 24" width="34" height="34" fill="none" aria-hidden="true" className="text-black">
    <path
      d="M3.19048 15L6.50933 6.28801C6.80476 5.5125 7.54842 5 8.3783 5H15.6217C16.4516 5 17.1952 5.5125 17.4907 6.28801L20.8095 15M18.0161 16.0161L18 16M6.375 19H17.625C19.489 19 21 17.6569 21 16C21 14.3431 19.489 13 17.625 13H6.375C4.51104 13 3 14.3431 3 16C3 17.6569 4.51104 19 6.375 19Z"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

// Drive node: same card as a workspace (icon + name + description), so the two node types are
// visually consistent. Top and bottom source handles let you start a drive->workspace link;
// the edges float (anchor to the nearest border), so two handles are enough.
function DriveNode({ data, selected }: NodeProps) {
  return (
    <NodeCard
      icon={<DriveIcon />}
      label={data.label as string}
      description={data.description as string}
      selected={selected}
      title="Open drive"
      className="cursor-pointer"
    >
      <Handle id="drive-top" type="source" position={Position.Top} className="graph-handle" />
      <Handle id="drive-bottom" type="source" position={Position.Bottom} className="graph-handle" />
    </NodeCard>
  );
}

interface WorkspaceItem {
  id: string;
  name: string;
  description?: string;
}
interface DriveItem {
  id: string;
  name: string;
  description?: string;
}
interface DriveConnectionItem {
  id: string;
  driveId: string;
  workspaceId: string;
  sourceHandle?: string;
  targetHandle?: string;
}

// Workspace→workspace edges float (anchor to the nearest border) so the arrow stays visually
// attached as nodes are dragged. The top handle is still the agent's input and the bottom its
// output for connection purposes, but the rendered path follows whichever sides face each other.
const EDGE_STYLE = {
  type: "floating" as const,
  style: { stroke: "var(--color-text-3)", strokeWidth: 1.5 },
  markerEnd: { type: MarkerType.ArrowClosed, color: "var(--color-primary)" },
};

// Drive↔workspace links are visually distinct (dashed, no arrow) and carry kind:"drive" so they
// are persisted separately from the agent-call graph and excluded from cycle checks. These float
// (anchor to the nearest border) since a drive has no input/output orientation.
const DRIVE_EDGE_STYLE = {
  type: "floating" as const,
  style: { stroke: "var(--color-text-3)", strokeWidth: 1.5, strokeDasharray: "5 4" },
  data: { kind: "drive" as const },
};

const FAIL_LINKS = "Failed to save drive links";

const plural = (n: number, noun: string) => `${n} ${noun}${n > 1 ? "s" : ""}`;

/** Delete keys belong to whatever field has focus before they belong to the canvas. */
const isTyping = (target: EventTarget | null) => {
  const el = target as HTMLElement | null;
  return !!el && (el.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName));
};

function wouldCreateCycle(edges: Edge[], source: string, target: string): boolean {
  const adj = new Map<string, string[]>();
  for (const e of edges) {
    if (e.data?.kind === "drive") continue;
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
  const nodeTypes = useMemo(() => ({ workspace: WorkspaceNode, drive: DriveNode }), []);
  const edgeTypes = useMemo(() => ({ floating: FloatingEdge }), []);
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [isDirty, setIsDirty] = useState(false);
  const [showUnsavedModal, setShowUnsavedModal] = useState(false);
  const [showDriveForm, setShowDriveForm] = useState(false);
  const [driveName, setDriveName] = useState("");
  const [driveDescription, setDriveDescription] = useState("");
  // Drives removed from the canvas but still in the store; Save is what actually destroys them.
  const [pendingDriveDeletes, setPendingDriveDeletes] = useState<Node[]>([]);
  // Everything the canvas can delete: drive nodes and any edge. Agents are deletable:false and are
  // never part of it — they are deleted from the home page, not here.
  const selection = useMemo(() => {
    const drives = nodes.filter((n) => n.selected && n.data?.kind === "drive");
    const links = edges.filter((e) => e.selected);
    const parts: string[] = [];
    if (drives.length) parts.push(plural(drives.length, "drive"));
    if (links.length) parts.push(plural(links.length, "link"));
    return { drives, links, label: parts.join(" and ") };
  }, [nodes, edges]);
  const driveIdsRef = useRef<Set<string>>(new Set());
  // Drive connections as they exist in the store, keyed by edge id. persist() diffs the current
  // drive edges against this to work out what to create and what to delete.
  const savedDriveConnsRef = useRef<Map<string, DriveConnectionItem>>(new Map());
  const nodesRef = useRef<Node[]>([]);
  const edgesRef = useRef<Edge[]>([]);
  const errorTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    nodesRef.current = nodes;
  }, [nodes]);
  useEffect(() => {
    edgesRef.current = edges;
  }, [edges]);

  const showError = useCallback((msg: string) => {
    setError(msg);
    if (errorTimer.current) clearTimeout(errorTimer.current);
    errorTimer.current = setTimeout(() => setError(null), 3000);
  }, []);

  // The one way anything leaves the canvas, shared by the Delete button and the delete key. Nothing
  // here touches the store: drives and links alike come back if you leave without saving.
  const deleteSelection = useCallback(() => {
    const { drives, links } = selection;
    if (!drives.length && !links.length) return;
    const goneDrives = new Set(drives.map((d) => d.id));
    const goneLinks = new Set(links.map((e) => e.id));
    setPendingDriveDeletes((ds) => [...ds, ...drives]);
    setNodes((nds) => nds.filter((n) => !goneDrives.has(n.id)));
    // A drive's links go with it, selected or not — they cannot outlive the node they hang off.
    setEdges((eds) =>
      eds.filter((e) => !goneLinks.has(e.id) && !goneDrives.has(e.source) && !goneDrives.has(e.target)),
    );
    setIsDirty(true);
  }, [selection, setEdges, setNodes]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.key === "Backspace" || e.key === "Delete") && !isTyping(e.target)) deleteSelection();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [deleteSelection]);

  useEffect(() => {
    Promise.all([
      fetch("/api/workspaces").then((r) => r.json()) as Promise<WorkspaceItem[]>,
      fetch("/api/workspace-graph").then((r) => {
        if (!r.ok) throw new Error("graph-disabled");
        return r.json() as Promise<{ edges: Edge[]; positions: Record<string, { x: number; y: number }> }>;
      }),
      fetch("/api/drives").then((r) => (r.ok ? r.json() : [])) as Promise<DriveItem[]>,
      fetch("/api/drive-connections").then((r) => (r.ok ? r.json() : [])) as Promise<DriveConnectionItem[]>,
    ])
      .then(([wss, graph, drives, connections]) => {
        const positions = graph.positions ?? {};
        const workspaceIds = new Set(wss.map((ws) => ws.id));
        driveIdsRef.current = new Set(drives.map((d) => d.id));
        const wsNodes: Node[] = wss.map((ws, i) => ({
          id: ws.id,
          type: "workspace",
          deletable: false,
          position: positions[ws.id] ?? { x: 80 + (i % 3) * 260, y: 80 + Math.floor(i / 3) * 220 },
          data: { label: ws.name, description: ws.description ?? "" },
        }));
        const driveNodes: Node[] = drives.map((d, i) => ({
          id: d.id,
          type: "drive",
          deletable: false,
          position: positions[d.id] ?? { x: 80 + (i % 3) * 260, y: 460 + Math.floor(i / 3) * 200 },
          data: { label: d.name, description: d.description, kind: "drive" },
        }));
        setNodes([...wsNodes, ...driveNodes]);
        const wsEdges = (graph.edges ?? []).map((e) => ({
          ...e,
          sourceHandle: workspaceIds.has(e.source) ? WORKSPACE_BOTTOM_HANDLE : e.sourceHandle,
          targetHandle: workspaceIds.has(e.target) ? WORKSPACE_TOP_HANDLE : e.targetHandle,
          ...EDGE_STYLE,
        }));
        savedDriveConnsRef.current = new Map(connections.map((c) => [c.id, c]));
        const driveEdges: Edge[] = connections.map((c) => ({
          id: c.id,
          source: c.driveId,
          target: c.workspaceId,
          sourceHandle: c.sourceHandle,
          targetHandle: normalizeWorkspaceIncomingHandle(c.targetHandle),
          ...DRIVE_EDGE_STYLE,
        }));
        setEdges([...wsEdges, ...driveEdges]);
        setReady(true);
      })
      .catch((e: unknown) => {
        if (e instanceof Error && e.message === "graph-disabled") router.replace("/");
        else setReady(true);
      });
  }, [setNodes, setEdges, router]);

  useEffect(() => {
    const handler = (e: BeforeUnloadEvent) => {
      if (!isDirty) return;
      e.preventDefault();
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [isDirty]);

  const onConnect = useCallback(
    (connection: Connection) => {
      if (!connection.source || !connection.target) return;
      if (connection.source === connection.target) {
        showError("A node cannot connect to itself.");
        return;
      }
      const srcDrive = driveIdsRef.current.has(connection.source);
      const tgtDrive = driveIdsRef.current.has(connection.target);

      // Drive↔workspace link: batched like agent edges and written to its own store on Save.
      if (srcDrive || tgtDrive) {
        if (srcDrive && tgtDrive) {
          showError("Drives can only connect to workspaces.");
          return;
        }
        const driveId = srcDrive ? connection.source : connection.target;
        const workspaceId = srcDrive ? connection.target : connection.source;
        const sourceHandle = srcDrive ? connection.sourceHandle : connection.targetHandle;
        const targetHandle = normalizeWorkspaceIncomingHandle(
          srcDrive ? connection.targetHandle : connection.sourceHandle,
        );
        const existing = edgesRef.current.find(
          (e) => e.data?.kind === "drive" && e.source === driveId && e.target === workspaceId,
        );
        if (existing && existing.sourceHandle === sourceHandle && existing.targetHandle === targetHandle) return;
        // Re-dragging an existing link only moves its handles, so keep the id: the save then sees
        // a handle change on a known connection rather than an unrelated create. A new link gets a
        // throwaway id and picks up its real one from the store on Save.
        const nextEdge: Edge = {
          id: existing?.id ?? crypto.randomUUID(),
          source: driveId,
          target: workspaceId,
          sourceHandle,
          targetHandle,
          ...DRIVE_EDGE_STYLE,
        };
        setEdges((eds) => (existing ? eds.map((e) => (e.id === existing.id ? nextEdge : e)) : [...eds, nextEdge]));
        setIsDirty(true);
        return;
      }

      // Workspace→workspace agent-call edge: batched, cycle-checked, saved on Save.
      if (wouldCreateCycle(edgesRef.current, connection.source, connection.target)) {
        showError("Loop detected — agents cannot call back up the chain.");
        return;
      }
      setEdges((eds) => addEdge({ ...connection, ...EDGE_STYLE }, eds));
      setIsDirty(true);
    },
    [setEdges, showError],
  );

  const onNodeDragStop = useCallback(() => {
    setIsDirty(true);
  }, []);

  // Double-click a node to open it: drives go to their file browser, workspaces to the workspace.
  const onNodeDoubleClick = useCallback(
    (_: React.MouseEvent, node: Node) => {
      if (node.data?.kind === "drive") router.push(`/drive/${node.id}`);
      else router.push(`/workspace/${node.id}`);
    },
    [router],
  );

  // Drives and their links have no bulk endpoint, so reconcile them one call at a time against
  // savedDriveConnsRef, which tracks what the store actually holds. Each step updates that ref as
  // it succeeds, so a save that fails partway can be retried and picks up where it stopped.
  const persistDrives = useCallback(async () => {
    const saved = savedDriveConnsRef.current;
    const send = async (url: string, init: RequestInit, fail: string) => {
      const res = await fetch(url, init);
      if (!res.ok) throw new Error(fail);
      return res;
    };
    const asJson = (body: unknown): RequestInit => ({
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    // Deleting a drive drops its connections server-side too, so this runs first and forgets them
    // here — otherwise the reconcile below would try to delete each of them a second time.
    for (const drive of pendingDriveDeletes) {
      await send(`/api/drives/${drive.id}`, { method: "DELETE" }, `Failed to delete ${drive.data.label}`);
      driveIdsRef.current.delete(drive.id);
      for (const [id, conn] of saved) if (conn.driveId === drive.id) saved.delete(id);
      setPendingDriveDeletes((ds) => ds.filter((d) => d.id !== drive.id));
    }

    const isSaved = (edge: Edge) => {
      const conn = saved.get(edge.id);
      return (
        !!conn &&
        conn.sourceHandle === edge.sourceHandle &&
        normalizeWorkspaceIncomingHandle(conn.targetHandle) === edge.targetHandle
      );
    };
    const driveEdges = edgesRef.current.filter((e) => e.data?.kind === "drive");
    const kept = new Set(driveEdges.filter(isSaved).map((e) => e.id));

    for (const connectionId of [...saved.keys()].filter((id) => !kept.has(id))) {
      await send("/api/drive-connections", { method: "DELETE", ...asJson({ connectionId }) }, FAIL_LINKS);
      saved.delete(connectionId);
    }
    // A link whose handles moved is deleted above and recreated here, so it comes back with a new
    // store id; swap that onto the edge to keep canvas and store in sync.
    const newIds = new Map<string, string>();
    for (const edge of driveEdges.filter((e) => !isSaved(e))) {
      const res = await send(
        "/api/drive-connections",
        {
          method: "POST",
          ...asJson({
            driveId: edge.source,
            workspaceId: edge.target,
            sourceHandle: edge.sourceHandle,
            targetHandle: edge.targetHandle,
          }),
        },
        FAIL_LINKS,
      );
      const conn = (await res.json()) as DriveConnectionItem;
      saved.set(conn.id, conn);
      newIds.set(edge.id, conn.id);
    }
    if (newIds.size) setEdges((eds) => eds.map((e) => (newIds.has(e.id) ? { ...e, id: newIds.get(e.id)! } : e)));
  }, [pendingDriveDeletes, setEdges]);

  // Only workspace→workspace edges go to the agent graph; drive edges live in their own store.
  const persist = useCallback(async () => {
    const positions: Record<string, { x: number; y: number }> = {};
    nodesRef.current.forEach((n) => {
      positions[n.id] = n.position;
    });
    const wsEdges = edgesRef.current
      .filter((e) => e.data?.kind !== "drive")
      .map((e) => ({ id: e.id, source: e.source, target: e.target }));
    const res = await fetch("/api/workspace-graph", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ edges: wsEdges, positions }),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(body.error ?? `Save failed (${res.status})`);
    }
    await persistDrives();
  }, [persistDrives]);

  // Removing a drive node is reversible until Save, so the point of no return is here rather than
  // at the click — this is where the files actually go.
  const confirmDriveDeletes = useCallback(() => {
    if (!pendingDriveDeletes.length) return true;
    const names = pendingDriveDeletes.map((d) => d.data.label as string).join(", ");
    const it = pendingDriveDeletes.length > 1 ? "them" : "it";
    return confirm(`Saving permanently deletes ${names} and everything stored in ${it}. Continue?`);
  }, [pendingDriveDeletes]);

  const handleSave = useCallback(async () => {
    if (!confirmDriveDeletes()) return;
    try {
      await persist();
      setIsDirty(false);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (err) {
      showError(err instanceof Error ? err.message : "Save failed");
    }
  }, [confirmDriveDeletes, persist, showError]);

  const handleCreateDrive = useCallback(async () => {
    const name = driveName.trim();
    if (!name) return;
    const description = driveDescription.trim();
    try {
      const res = await fetch("/api/drives", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, description: description || undefined }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? "Create failed");
      }
      const drive = (await res.json()) as DriveItem;
      driveIdsRef.current.add(drive.id);
      setNodes((nds) => [
        ...nds,
        {
          id: drive.id,
          type: "drive",
          deletable: false,
          position: { x: 200, y: 320 },
          data: { label: drive.name, description: drive.description, kind: "drive" },
        },
      ]);
      setDriveName("");
      setDriveDescription("");
      setShowDriveForm(false);
    } catch (err) {
      showError(err instanceof Error ? err.message : "Create failed");
    }
  }, [driveName, driveDescription, setNodes, showError]);

  const handleBack = useCallback(() => {
    if (isDirty) setShowUnsavedModal(true);
    else router.push("/");
  }, [isDirty, router]);

  const handleSaveAndLeave = useCallback(async () => {
    if (!confirmDriveDeletes()) return;
    try {
      await persist();
      router.push("/");
    } catch (err) {
      showError(err instanceof Error ? err.message : "Save failed");
    }
  }, [confirmDriveDeletes, persist, router, showError]);

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
              <Image
                src="/paodo-logo.svg"
                alt="Paodo logo"
                width={34}
                height={34}
                className="block w-full h-full object-cover"
                unoptimized
              />
            </button>
            <span className="font-semibold tracking-[-0.01em] text-lg leading-none inline-flex items-center">
              PAODO Workspace agents
            </span>
          </div>
        }
        right={
          <div className="flex items-center gap-2.5">
            {isDirty && <span className="text-xs text-text-3 italic">Unsaved changes</span>}
            <button className="btn btn-ghost btn-sm" onClick={() => setShowDriveForm((v) => !v)}>
              Add drive
            </button>
            {selection.label && (
              <button
                className="btn btn-ghost btn-sm text-danger"
                onClick={deleteSelection}
                title={`Delete ${selection.label}`}
              >
                Delete
              </button>
            )}
            <button className="btn btn-primary btn-sm" onClick={handleSave} disabled={!isDirty}>
              {saved ? "Saved ✓" : "Save"}
            </button>
          </div>
        }
      />

      <div className="flex-1 min-h-0 relative">
        {showDriveForm && (
          <div className="absolute top-3 right-3 z-20 bg-white border border-border rounded-card p-3 shadow-md flex flex-col gap-2 w-[260px]">
            <div className="font-semibold text-sm text-text">New shared drive</div>
            <input
              autoFocus
              className="input"
              placeholder="Drive name (no spaces)"
              value={driveName}
              onChange={(e) => setDriveName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleCreateDrive();
                if (e.key === "Escape") setShowDriveForm(false);
              }}
            />
            <textarea
              className="input resize-none"
              rows={3}
              placeholder="Description (optional)"
              value={driveDescription}
              onChange={(e) => setDriveDescription(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") setShowDriveForm(false);
              }}
            />
            <div className="flex gap-2 items-center">
              <button className="btn btn-primary btn-sm" onClick={handleCreateDrive}>
                Create
              </button>
              <button className="linkbtn" onClick={() => setShowDriveForm(false)}>
                Cancel
              </button>
            </div>
          </div>
        )}
        {ready && (
          <ReactFlow
            nodes={nodes}
            edges={edges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onNodeDragStop={onNodeDragStop}
            onNodeDoubleClick={onNodeDoubleClick}
            connectionMode={ConnectionMode.Loose}
            connectionLineComponent={FloatingConnectionLine}
            nodeTypes={nodeTypes}
            edgeTypes={edgeTypes}
            fitView
            fitViewOptions={{ padding: 0.3, maxZoom: 1 }}
            nodeDragThreshold={4}
            deleteKeyCode={null}
            multiSelectionKeyCode="Shift"
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
              {pendingDriveDeletes.length > 0 && (
                <span className="block mt-2 text-danger">
                  Saving permanently deletes {pendingDriveDeletes.map((d) => d.data.label as string).join(", ")} and
                  everything stored in {pendingDriveDeletes.length > 1 ? "them" : "it"}.
                </span>
              )}
            </p>
            <div className="flex gap-2.5 items-center flex-wrap">
              <button className="btn btn-primary" onClick={handleSaveAndLeave}>
                Save &amp; leave
              </button>
              <button className="btn" onClick={() => router.push("/")}>
                Leave without saving
              </button>
              <button className="linkbtn" onClick={() => setShowUnsavedModal(false)}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
