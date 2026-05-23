// Workspace page — the main three-column layout combining the file tree, file viewer, chat panel, and console.
// Manages column/row resize state and coordinates file selection, viewer visibility, and tree refreshes across panels.
"use client";

import { use, useState, useEffect, useRef, useCallback } from "react";
import FileTreePanel from "@/components/workspace/FileTreePanel";
import FileViewer from "@/components/workspace/FileViewer";
import ChatPanel from "@/components/workspace/ChatPanel";
import ConsolePanel from "@/components/workspace/ConsolePanel";

export default function WorkspacePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [workspaceName, setWorkspaceName] = useState<string>("");
  const [workspaceDir, setWorkspaceDir] = useState<string>("");
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [selectedPermission, setSelectedPermission] = useState<"R" | "RW">("RW");
  const [viewerOpen, setViewerOpen] = useState(false);

  // Column widths (px)
  const [leftWidth, setLeftWidth] = useState(220);
  const [rightWidth, setRightWidth] = useState(400);
  const [treeRefreshKey, setTreeRefreshKey] = useState(0);

  // Chat/console vertical split
  const [chatRatio, setChatRatio] = useState(0.62);

  const [isDragging, setIsDragging] = useState(false);

  const containerRef = useRef<HTMLDivElement>(null);
  const rightRef = useRef<HTMLDivElement>(null);
  const colDragging = useRef<"left" | "right" | null>(null);
  const rowDragging = useRef(false);

  useEffect(() => {
    fetch(`/api/workspaces/${id}`)
      .then((r) => r.json())
      .then((data) => {
        const ws = data as { name: string; dir: string };
        setWorkspaceName(ws.name);
        setWorkspaceDir(ws.dir);
      })
      .catch(() => {});
  }, [id]);

  // Column resize
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!colDragging.current || !containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      if (colDragging.current === "left") {
        setLeftWidth(Math.max(150, Math.min(500, e.clientX - rect.left)));
      } else {
        setRightWidth(Math.max(300, Math.min(700, rect.right - e.clientX)));
      }
    };
    const onUp = () => {
      if (!colDragging.current) return;
      colDragging.current = null;
      setIsDragging(false);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, []);

  // Chat/console vertical resize
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!rowDragging.current || !rightRef.current) return;
      const rect = rightRef.current.getBoundingClientRect();
      setChatRatio(Math.max(0.2, Math.min(0.85, (e.clientY - rect.top) / rect.height)));
    };
    const onUp = () => {
      if (!rowDragging.current) return;
      rowDragging.current = false;
      setIsDragging(false);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, []);

  const startColDrag = useCallback((side: "left" | "right") => {
    colDragging.current = side;
    setIsDragging(true);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  }, []);

  const startRowDrag = useCallback(() => {
    rowDragging.current = true;
    setIsDragging(true);
    document.body.style.cursor = "row-resize";
    document.body.style.userSelect = "none";
  }, []);

  return (
    <div className="workspace" ref={containerRef}>
      {isDragging && <div style={{ position: "fixed", inset: 0, zIndex: 9999 }} />}
      {/* LEFT — file tree */}
      <FileTreePanel
        workspaceId={id}
        workspaceName={workspaceName}
        wsDir={workspaceDir}
        selectedPath={selectedFile}
        onFileSelect={(path, permission) => { setSelectedFile(path); setSelectedPermission(permission); setViewerOpen(true); }}
        onPermissionChange={(path, perm) => { if (path === null || path === selectedFile) setSelectedPermission(perm); }}
        onDeletedPaths={(paths) => {
          if (selectedFile && paths.includes(selectedFile)) {
            setSelectedFile(null);
            setViewerOpen(false);
          }
        }}
        style={{ width: leftWidth, minWidth: 150, flex: "none" }}
        refreshKey={treeRefreshKey}
      />

      {/* CENTER — file viewer (closable) */}
      {viewerOpen && (
        <>
          <div className="ws-divider" onMouseDown={() => startColDrag("left")} />
          <section className="ws-center">
            <FileViewer
              workspaceId={id}
              filePath={selectedFile}
              permission={selectedPermission}
              onClose={() => setViewerOpen(false)}
              onDeleted={() => { setViewerOpen(false); setTreeRefreshKey((k) => k + 1); }}
            />
          </section>
        </>
      )}

      <div className="ws-divider" onMouseDown={() => startColDrag(viewerOpen ? "right" : "left")} />

      {/* RIGHT — chat + console */}
      <aside
        ref={rightRef}
        className="ws-right"
        style={viewerOpen
          ? { width: rightWidth, minWidth: 300, flex: "none" }
          : { flex: 1, width: "auto", minWidth: 0 }
        }
      >
        <div className="ws-right-top" style={{ flex: chatRatio }}>
          <ChatPanel
            workspaceId={id}
            onAgentTurnComplete={() => setTreeRefreshKey((k) => k + 1)}
          />
        </div>
        <div className="ws-right-handle" onMouseDown={startRowDrag} />
        <div className="ws-right-bottom" style={{ flex: 1 - chatRatio }}>
          <ConsolePanel workspaceId={id} />
        </div>
      </aside>
    </div>
  );
}
