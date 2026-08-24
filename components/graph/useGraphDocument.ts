"use client";

// Editable graph-document state: what is on the canvas, what changed, and the save transaction.
// The rules it applies live in sibling modules (connectionRules, buildGraph, driveSync, graphApi).
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useEdgesState, useNodesState, type Connection, type Edge, type Node } from "@xyflow/react";
import * as api from "./graphApi";
import { type DriveConnectionItem } from "./graphApi";
import { buildEdges, buildNodes, driveNode, nextFreeCell, storedPositions } from "./buildGraph";
import { applyConnection, resolveConnection } from "./connectionRules";
import { syncDrives } from "./driveSync";
import { useNodePlacement } from "./useNodePlacement";
import { driveDeleteWarning, isDriveEdge, isDriveNode } from "./types";

const plural = (count: number, noun: string) => `${count} ${noun}${count > 1 ? "s" : ""}`;

function isTyping(target: EventTarget | null) {
  const element = target as HTMLElement | null;
  return !!element && (element.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(element.tagName));
}

interface GraphDocumentOptions {
  showError(message: string): void;
}

export function useGraphDocument({ showError }: GraphDocumentOptions) {
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

  const markDirty = useCallback(() => setIsDirty(true), []);
  const getNodes = useCallback(() => nodesRef.current, []);
  const { onNodeDragStart, onNodeDragStop } = useNodePlacement({ getNodes, setNodes, onMoved: markDirty });

  // Derived from `nodes` rather than tracked separately, so a drive removed from the canvas (even
  // before the delete is saved) stops counting as a drive immediately instead of until the next save.
  const driveIds = useMemo(() => new Set(nodes.filter(isDriveNode).map((node) => node.id)), [nodes]);

  const selection = useMemo(() => {
    const drives = nodes.filter((node) => node.selected && isDriveNode(node));
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
    markDirty();
  }, [markDirty, selection, setEdges, setNodes]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.key === "Backspace" || event.key === "Delete") && !isTyping(event.target)) deleteSelection();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [deleteSelection]);

  useEffect(() => {
    api
      .fetchGraphDocument()
      .then(({ workspaces, graph, drives, connections }) => {
        setNodes(buildNodes({ workspaces, drives, graph }));
        savedDriveConnectionsRef.current = new Map(connections.map((connection) => [connection.id, connection]));
        setEdges(buildEdges(graph, connections, workspaces));
        setReady(true);
      })
      .catch((error: unknown) => {
        showError(error instanceof Error ? error.message : "Failed to load the graph");
        setReady(true);
      });
  }, [setEdges, setNodes, showError]);

  const onConnect = useCallback(
    (connection: Connection) => {
      const outcome = resolveConnection(connection, { driveIds, edges: edgesRef.current });
      if (outcome.kind === "ignored") return;
      if (outcome.kind === "rejected") {
        showError(outcome.message);
        return;
      }
      setEdges((current) => applyConnection(outcome, current));
      markDirty();
    },
    [driveIds, markDirty, setEdges, showError],
  );

  const persist = useCallback(async () => {
    const workspaceEdges = edgesRef.current
      .filter((edge) => !isDriveEdge(edge))
      .map((edge) => ({ id: edge.id, source: edge.source, target: edge.target }));
    const stored = await api.saveGraph(workspaceEdges, storedPositions(nodesRef.current));
    // Both halves of the save mint their own ids, so a newly drawn edge comes back under one the
    // canvas has not seen. Workspace edges answer in the order they were sent; drive links answer one
    // at a time. Either way the canvas adopts what it is given, or it resends a dead id next save.
    const renamed = new Map<string, string>();
    workspaceEdges.forEach((sent, index) => {
      const id = stored[index]?.id;
      if (id && id !== sent.id) renamed.set(sent.id, id);
    });
    const links = await syncDrives({
      edges: edgesRef.current,
      saved: savedDriveConnectionsRef.current,
      pendingDeletes: pendingDriveDeletes,
      onDriveDeleted: (driveId) =>
        setPendingDriveDeletes((current) => current.filter((candidate) => candidate.id !== driveId)),
    });
    for (const [from, to] of links) renamed.set(from, to);
    if (renamed.size) {
      setEdges((current) =>
        current.map((edge) => (renamed.has(edge.id) ? { ...edge, id: renamed.get(edge.id)! } : edge)),
      );
    }
  }, [pendingDriveDeletes, setEdges]);

  const save = useCallback(async (): Promise<boolean> => {
    if (pendingDriveDeletes.length && !confirm(`${driveDeleteWarning(pendingDriveDeletes)} Continue?`)) return false;
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
  }, [pendingDriveDeletes, persist, showError]);

  const createDrive = useCallback(
    async (rawName: string, rawDescription: string): Promise<boolean> => {
      const name = rawName.trim();
      if (!name) return false;
      try {
        const drive = await api.createDrive(name, rawDescription.trim() || undefined);
        setNodes((current) => [...current, driveNode(drive, nextFreeCell(current))]);
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
    onNodeDragStart,
    onNodeDragStop,
    deleteSelection,
    createDrive,
    save,
  };
}
