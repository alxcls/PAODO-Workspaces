// Workspace page — the main three-column layout combining the file tree, file viewer, chat panel, and console.
// Manages column/row resize state and coordinates file selection, viewer visibility, and tree refreshes across panels.
// A single shared WebSocket (useWorkspaceSocket) routes files_changed / files_deleted events to both the
// file tree (via treeRefreshKey) and the file viewer (via the imperative FileViewerHandle ref).
"use client";

import { use, useState, useEffect, useRef, useCallback } from "react";
import Image from "next/image";
import { useRouter } from "next/navigation";
import FileTreePanel from "@/components/workspace/FileTreePanel";
import FileViewer, { type FileViewerHandle } from "@/components/workspace/FileViewer";
import ChatPanel from "@/components/workspace/ChatPanel";
import ConsolePanel from "@/components/workspace/ConsolePanel";
import TopBar from "@/components/layout/TopBar";
import { useWorkspaceSocket } from "@/lib/client/hooks/useWorkspaceSocket";
import { useWorkspaceMeta } from "@/lib/client/hooks/useWorkspaceMeta";

export default function WorkspacePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const { name: workspaceName } = useWorkspaceMeta(id);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [viewerOpen, setViewerOpen] = useState(false);

  const [leftWidth, setLeftWidth] = useState(220);
  const [rightWidth, setRightWidth] = useState(400);
  const [treeRefreshKey, setTreeRefreshKey] = useState(0);
  const [chatRatio, setChatRatio] = useState(0.62);
  const [isDragging, setIsDragging] = useState(false);

  const containerRef = useRef<HTMLDivElement>(null);
  const rightRef = useRef<HTMLDivElement>(null);
  const colDragging = useRef<"left" | "right" | null>(null);
  const rowDragging = useRef(false);
  const viewerRef = useRef<FileViewerHandle>(null);

  const { sendMessage } = useWorkspaceSocket(id, {
    files_changed: (msg) => {
      setTreeRefreshKey((k) => k + 1);
      viewerRef.current?.notifyFilesChanged(msg.paths ?? []);
    },
    files_deleted: (msg) => {
      setTreeRefreshKey((k) => k + 1);
      viewerRef.current?.notifyFilesDeleted(msg.paths ?? []);
    },
  });

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!colDragging.current || !containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      if (colDragging.current === "left") {
        setLeftWidth(Math.max(220, Math.min(500, e.clientX - rect.left)));
      } else {
        setRightWidth(Math.max(300, Math.min(700, rect.right - e.clientX)));
      }
    };
    const onUp = () => {
      if (!colDragging.current) return;
      colDragging.current = null; setIsDragging(false);
      document.body.style.cursor = ""; document.body.style.userSelect = "";
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => { window.removeEventListener("mousemove", onMove); window.removeEventListener("mouseup", onUp); };
  }, []);

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!rowDragging.current || !rightRef.current) return;
      const rect = rightRef.current.getBoundingClientRect();
      setChatRatio(Math.max(0.2, Math.min(0.85, (e.clientY - rect.top) / rect.height)));
    };
    const onUp = () => {
      if (!rowDragging.current) return;
      rowDragging.current = false; setIsDragging(false);
      document.body.style.cursor = ""; document.body.style.userSelect = "";
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => { window.removeEventListener("mousemove", onMove); window.removeEventListener("mouseup", onUp); };
  }, []);

  const startColDrag = useCallback((side: "left" | "right") => {
    colDragging.current = side; setIsDragging(true);
    document.body.style.cursor = "col-resize"; document.body.style.userSelect = "none";
  }, []);

  const startRowDrag = useCallback(() => {
    rowDragging.current = true; setIsDragging(true);
    document.body.style.cursor = "row-resize"; document.body.style.userSelect = "none";
  }, []);

  return (
    <div className="flex flex-col h-screen bg-bg overflow-hidden">
      <TopBar
        left={
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => router.push("/")}
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
      />

      <div className="flex flex-1 min-h-0" ref={containerRef}>
        {isDragging && <div style={{ position: "fixed", inset: 0, zIndex: 9999 }} />}

        <FileTreePanel
        workspaceId={id} workspaceName={workspaceName}
        selectedPath={selectedFile}
        onFileSelect={(path) => { setSelectedFile(path); setViewerOpen(true); }}
        onDeletedPaths={(paths) => {
          if (selectedFile && paths.includes(selectedFile)) { setSelectedFile(null); setViewerOpen(false); }
        }}
        style={{ width: leftWidth, minWidth: 220, flex: "none" }}
        refreshKey={treeRefreshKey}
      />

      {viewerOpen && (
        <>
          <div className="ws-divider" onMouseDown={() => startColDrag("left")} />
          <section className="flex-1 flex flex-col min-w-0 min-h-0 bg-bg">
            <FileViewer
              ref={viewerRef}
              workspaceId={id} filePath={selectedFile}
              onClose={() => setViewerOpen(false)}
              onSelfWrite={(path) => sendMessage({ type: "self_write", path })}
            />
          </section>
        </>
      )}

      <div className="ws-divider" onMouseDown={() => startColDrag(viewerOpen ? "right" : "left")} />

      <aside
        ref={rightRef}
        className="flex flex-col bg-bg overflow-hidden relative"
        style={viewerOpen
          ? { width: rightWidth, minWidth: 300, flex: "none" }
          : { flex: 1, width: "auto", minWidth: 0 }
        }
      >
        <div className="flex flex-col min-h-0 overflow-hidden" style={{ flex: chatRatio }}>
          <ChatPanel workspaceId={id} onAgentTurnComplete={() => setTreeRefreshKey((k) => k + 1)} />
        </div>
        <div className="ws-right-handle" onMouseDown={startRowDrag} />
        <div className="flex flex-col min-h-0 overflow-hidden" style={{ flex: 1 - chatRatio }}>
          <ConsolePanel workspaceId={id} />
        </div>
      </aside>
      </div>
    </div>
  );
}
