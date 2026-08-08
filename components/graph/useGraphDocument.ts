"use client";

// Editable graph-document state and persistence. GraphEditor renders controls and navigation;
// this hook owns graph loading, validation, dirty tracking, and the save transaction.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  addEdge,
  MarkerType,
  useEdgesState,
  useNodesState,
  type Connection,
  type Edge,
  type Node,
} from "@xyflow/react";
import { WORKSPACE_BOTTOM_HANDLE, WORKSPACE_TOP_HANDLE, normalizeWorkspaceIncomingHandle } from "./handles";

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

const EDGE_STYLE = {
  type: "floating" as const,
  style: { stroke: "var(--color-text-3)", strokeWidth: 1.5 },
  markerEnd: { type: MarkerType.ArrowClosed, color: "var(--color-primary)" },
};

const DRIVE_EDGE_STYLE = {
  type: "floating" as const,
  style: { stroke: "var(--color-text-3)", strokeWidth: 1.5, strokeDasharray: "5 4" },
  data: { kind: "drive" as const },
};

const FAIL_LINKS = "Failed to save drive links";
const plural = (count: number, noun: string) => `${count} ${noun}${count > 1 ? "s" : ""}`;

function isTyping(target: EventTarget | null) {
  const element = target as HTMLElement | null;
  return !!element && (element.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(element.tagName));
}

function wouldCreateCycle(edges: Edge[], source: string, target: string): boolean {
  const adjacency = new Map<string, string[]>();
  for (const edge of edges) {
    if (edge.data?.kind === "drive") continue;
    if (!adjacency.has(edge.source)) adjacency.set(edge.source, []);
    adjacency.get(edge.source)!.push(edge.target);
  }
  const visited = new Set<string>();
  const queue = [target];
  while (queue.length) {
    const node = queue.shift()!;
    if (node === source) return true;
    if (visited.has(node)) continue;
    visited.add(node);
    for (const next of adjacency.get(node) ?? []) queue.push(next);
  }
  return false;
}

interface GraphDocumentOptions {
  onGraphDisabled(): void;
  showError(message: string): void;
}

export function useGraphDocument({ onGraphDisabled, showError }: GraphDocumentOptions) {
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [ready, setReady] = useState(false);
  const [saved, setSaved] = useState(false);
  const [isDirty, setIsDirty] = useState(false);
  const [pendingDriveDeletes, setPendingDriveDeletes] = useState<Node[]>([]);
  const savedDriveConnectionsRef = useRef<Map<string, DriveConnectionItem>>(new Map());
  const nodesRef = useRef<Node[]>([]);
  const edgesRef = useRef<Edge[]>([]);

  useEffect(() => {
    nodesRef.current = nodes;
  }, [nodes]);
  useEffect(() => {
    edgesRef.current = edges;
  }, [edges]);

  // Derived from `nodes` rather than tracked separately, so a drive removed from the canvas (even
  // before the delete is saved) stops counting as a drive immediately instead of until the next save/reload.
  const driveIds = useMemo(
    () => new Set(nodes.filter((node) => node.data?.kind === "drive").map((node) => node.id)),
    [nodes],
  );

  const selection = useMemo(() => {
    const drives = nodes.filter((node) => node.selected && node.data?.kind === "drive");
    const links = edges.filter((edge) => edge.selected);
    const parts: string[] = [];
    if (drives.length) parts.push(plural(drives.length, "drive"));
    if (links.length) parts.push(plural(links.length, "link"));
    return { drives, links, label: parts.join(" and ") };
  }, [nodes, edges]);

  const deleteSelection = useCallback(() => {
    const { drives, links } = selection;
    if (!drives.length && !links.length) return;
    const removedDrives = new Set(drives.map((drive) => drive.id));
    const removedLinks = new Set(links.map((link) => link.id));
    setPendingDriveDeletes((current) => [...current, ...drives]);
    setNodes((current) => current.filter((node) => !removedDrives.has(node.id)));
    setEdges((current) =>
      current.filter(
        (edge) => !removedLinks.has(edge.id) && !removedDrives.has(edge.source) && !removedDrives.has(edge.target),
      ),
    );
    setIsDirty(true);
  }, [selection, setEdges, setNodes]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.key === "Backspace" || event.key === "Delete") && !isTyping(event.target)) deleteSelection();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [deleteSelection]);

  useEffect(() => {
    Promise.all([
      fetch("/api/workspaces").then((response) => response.json()) as Promise<WorkspaceItem[]>,
      fetch("/api/workspace-graph").then((response) => {
        if (!response.ok) throw new Error("graph-disabled");
        return response.json() as Promise<{ edges: Edge[]; positions: Record<string, { x: number; y: number }> }>;
      }),
      fetch("/api/drives").then((response) => (response.ok ? response.json() : [])) as Promise<DriveItem[]>,
      fetch("/api/drive-connections").then((response) => (response.ok ? response.json() : [])) as Promise<
        DriveConnectionItem[]
      >,
    ])
      .then(([workspaces, graph, drives, connections]) => {
        const positions = graph.positions ?? {};
        const workspaceIds = new Set(workspaces.map((workspace) => workspace.id));
        const workspaceNodes: Node[] = workspaces.map((workspace, index) => ({
          id: workspace.id,
          type: "workspace",
          deletable: false,
          position: positions[workspace.id] ?? {
            x: 80 + (index % 3) * 260,
            y: 80 + Math.floor(index / 3) * 220,
          },
          data: { label: workspace.name, description: workspace.description ?? "" },
        }));
        const driveNodes: Node[] = drives.map((drive, index) => ({
          id: drive.id,
          type: "drive",
          deletable: false,
          position: positions[drive.id] ?? { x: 80 + (index % 3) * 260, y: 460 + Math.floor(index / 3) * 200 },
          data: { label: drive.name, description: drive.description, kind: "drive" },
        }));
        setNodes([...workspaceNodes, ...driveNodes]);
        const workspaceEdges = (graph.edges ?? []).map((edge) => ({
          ...edge,
          sourceHandle: workspaceIds.has(edge.source) ? WORKSPACE_BOTTOM_HANDLE : edge.sourceHandle,
          targetHandle: workspaceIds.has(edge.target) ? WORKSPACE_TOP_HANDLE : edge.targetHandle,
          ...EDGE_STYLE,
        }));
        savedDriveConnectionsRef.current = new Map(connections.map((connection) => [connection.id, connection]));
        const driveEdges: Edge[] = connections.map((connection) => ({
          id: connection.id,
          source: connection.driveId,
          target: connection.workspaceId,
          sourceHandle: connection.sourceHandle,
          targetHandle: normalizeWorkspaceIncomingHandle(connection.targetHandle),
          ...DRIVE_EDGE_STYLE,
        }));
        setEdges([...workspaceEdges, ...driveEdges]);
        setReady(true);
      })
      .catch((error: unknown) => {
        if (error instanceof Error && error.message === "graph-disabled") onGraphDisabled();
        else setReady(true);
      });
  }, [onGraphDisabled, setEdges, setNodes]);

  useEffect(() => {
    const handler = (event: BeforeUnloadEvent) => {
      if (!isDirty) return;
      event.preventDefault();
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
      const sourceIsDrive = driveIds.has(connection.source);
      const targetIsDrive = driveIds.has(connection.target);
      if (sourceIsDrive || targetIsDrive) {
        if (sourceIsDrive && targetIsDrive) {
          showError("Drives can only connect to workspaces.");
          return;
        }
        const driveId = sourceIsDrive ? connection.source : connection.target;
        const workspaceId = sourceIsDrive ? connection.target : connection.source;
        const sourceHandle = sourceIsDrive ? connection.sourceHandle : connection.targetHandle;
        const targetHandle = normalizeWorkspaceIncomingHandle(
          sourceIsDrive ? connection.targetHandle : connection.sourceHandle,
        );
        const existing = edgesRef.current.find(
          (edge) => edge.data?.kind === "drive" && edge.source === driveId && edge.target === workspaceId,
        );
        if (existing && existing.sourceHandle === sourceHandle && existing.targetHandle === targetHandle) return;
        const nextEdge: Edge = {
          id: existing?.id ?? crypto.randomUUID(),
          source: driveId,
          target: workspaceId,
          sourceHandle,
          targetHandle,
          ...DRIVE_EDGE_STYLE,
        };
        setEdges((current) =>
          existing ? current.map((edge) => (edge.id === existing.id ? nextEdge : edge)) : [...current, nextEdge],
        );
        setIsDirty(true);
        return;
      }
      if (wouldCreateCycle(edgesRef.current, connection.source, connection.target)) {
        showError("Loop detected — agents cannot call back up the chain.");
        return;
      }
      setEdges((current) => addEdge({ ...connection, ...EDGE_STYLE }, current));
      setIsDirty(true);
    },
    [driveIds, setEdges, showError],
  );

  const onNodeDragStop = useCallback(() => setIsDirty(true), []);

  const persistDrives = useCallback(async () => {
    const savedConnections = savedDriveConnectionsRef.current;
    const send = async (url: string, init: RequestInit, failure: string) => {
      const response = await fetch(url, init);
      if (!response.ok) throw new Error(failure);
      return response;
    };
    const asJson = (body: unknown): RequestInit => ({
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    for (const drive of pendingDriveDeletes) {
      await send(`/api/drives/${drive.id}`, { method: "DELETE" }, `Failed to delete ${drive.data.label}`);
      for (const [id, connection] of savedConnections) {
        if (connection.driveId === drive.id) savedConnections.delete(id);
      }
      setPendingDriveDeletes((current) => current.filter((candidate) => candidate.id !== drive.id));
    }

    const isSaved = (edge: Edge) => {
      const connection = savedConnections.get(edge.id);
      return (
        !!connection &&
        connection.sourceHandle === edge.sourceHandle &&
        normalizeWorkspaceIncomingHandle(connection.targetHandle) === edge.targetHandle
      );
    };
    const driveEdges = edgesRef.current.filter((edge) => edge.data?.kind === "drive");
    const kept = new Set(driveEdges.filter(isSaved).map((edge) => edge.id));
    for (const connectionId of [...savedConnections.keys()].filter((id) => !kept.has(id))) {
      await send("/api/drive-connections", { method: "DELETE", ...asJson({ connectionId }) }, FAIL_LINKS);
      savedConnections.delete(connectionId);
    }

    const newIds = new Map<string, string>();
    for (const edge of driveEdges.filter((candidate) => !isSaved(candidate))) {
      const response = await send(
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
      const connection = (await response.json()) as DriveConnectionItem;
      savedConnections.set(connection.id, connection);
      newIds.set(edge.id, connection.id);
    }
    if (newIds.size) {
      setEdges((current) =>
        current.map((edge) => (newIds.has(edge.id) ? { ...edge, id: newIds.get(edge.id)! } : edge)),
      );
    }
  }, [pendingDriveDeletes, setEdges]);

  const persist = useCallback(async () => {
    const positions: Record<string, { x: number; y: number }> = {};
    nodesRef.current.forEach((node) => {
      positions[node.id] = node.position;
    });
    const workspaceEdges = edgesRef.current
      .filter((edge) => edge.data?.kind !== "drive")
      .map((edge) => ({ id: edge.id, source: edge.source, target: edge.target }));
    const response = await fetch("/api/workspace-graph", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ edges: workspaceEdges, positions }),
    });
    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as { error?: string };
      throw new Error(body.error ?? `Save failed (${response.status})`);
    }
    await persistDrives();
  }, [persistDrives]);

  const confirmDriveDeletes = useCallback(() => {
    if (!pendingDriveDeletes.length) return true;
    const names = pendingDriveDeletes.map((drive) => drive.data.label as string).join(", ");
    const pronoun = pendingDriveDeletes.length > 1 ? "them" : "it";
    return confirm(`Saving permanently deletes ${names} and everything stored in ${pronoun}. Continue?`);
  }, [pendingDriveDeletes]);

  const save = useCallback(async (): Promise<boolean> => {
    if (!confirmDriveDeletes()) return false;
    try {
      await persist();
      setIsDirty(false);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
      return true;
    } catch (error) {
      showError(error instanceof Error ? error.message : "Save failed");
      return false;
    }
  }, [confirmDriveDeletes, persist, showError]);

  const createDrive = useCallback(
    async (rawName: string, rawDescription: string): Promise<boolean> => {
      const name = rawName.trim();
      if (!name) return false;
      const description = rawDescription.trim();
      try {
        const response = await fetch("/api/drives", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name, description: description || undefined }),
        });
        if (!response.ok) {
          const body = (await response.json().catch(() => ({}))) as { error?: string };
          throw new Error(body.error ?? "Create failed");
        }
        const drive = (await response.json()) as DriveItem;
        setNodes((current) => [
          ...current,
          {
            id: drive.id,
            type: "drive",
            deletable: false,
            position: { x: 200, y: 320 },
            data: { label: drive.name, description: drive.description, kind: "drive" },
          },
        ]);
        return true;
      } catch (error) {
        showError(error instanceof Error ? error.message : "Create failed");
        return false;
      }
    },
    [setNodes, showError],
  );

  return {
    nodes,
    edges,
    ready,
    saved,
    isDirty,
    pendingDriveDeletes,
    selection,
    onNodesChange,
    onEdgesChange,
    onConnect,
    onNodeDragStop,
    deleteSelection,
    createDrive,
    save,
  };
}
