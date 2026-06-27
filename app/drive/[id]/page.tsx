// Shared-drive browser — a two-column file tree + viewer, mirroring the workspace file view.
// Reuses FileTreePanel and FileViewer pointed at the drive file API (apiBase=/api/drives/<id>).
// Drives are passive storage, so there is no chat, console, socket, or HTML live-preview here.
"use client";

import { use, useState, useEffect, useRef, useCallback } from "react";
import Image from "next/image";
import Link from "next/link";
import FileTreePanel from "@/components/workspace/FileTreePanel";
import FileViewer, { type FileViewerHandle } from "@/components/workspace/FileViewer";
import TopBar from "@/components/layout/TopBar";

export default function DrivePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const apiBase = `/api/drives/${id}`;

  const [driveName, setDriveName] = useState("");
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [viewerOpen, setViewerOpen] = useState(false);
  const [leftWidth, setLeftWidth] = useState(260);
  const [treeRefreshKey, setTreeRefreshKey] = useState(0);
  const [isDragging, setIsDragging] = useState(false);

  const containerRef = useRef<HTMLDivElement>(null);
  const colDragging = useRef(false);
  const viewerRef = useRef<FileViewerHandle>(null);

  useEffect(() => {
    fetch(`/api/drives/${id}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (d?.name) setDriveName(d.name); })
      .catch(() => {});
  }, [id]);

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!colDragging.current || !containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      setLeftWidth(Math.max(220, Math.min(500, e.clientX - rect.left)));
    };
    const onUp = () => { colDragging.current = false; setIsDragging(false); };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => { window.removeEventListener("mousemove", onMove); window.removeEventListener("mouseup", onUp); };
  }, []);

  // A save/upload/delete in this view should refresh the tree (no agent socket to do it for us).
  const refreshTree = useCallback(() => setTreeRefreshKey((k) => k + 1), []);

  return (
    <div className="h-screen flex flex-col bg-bg-tint">
      <TopBar
        left={
          <div className="flex items-center gap-2">
            <Link
              href="/graph"
              title="Back to network"
              className="w-[34px] h-[34px] rounded-[10px] overflow-hidden flex-shrink-0 inline-flex items-center justify-center bg-gradient-to-br from-primary to-primary-2 border-0 p-0 cursor-pointer"
            >
              <Image src="/paodo-logo.svg" alt="Paodo logo" width={34} height={34} draggable={false} className="block w-full h-full object-cover pointer-events-none" unoptimized />
            </Link>
            <span className="font-semibold tracking-[-0.01em] text-lg leading-none inline-flex items-center">
              PAODO WS agents
            </span>
          </div>
        }
      />

      <div ref={containerRef} className="flex-1 min-h-0 flex" style={{ userSelect: isDragging ? "none" : "auto" }}>
        <FileTreePanel
          apiBase={apiBase}
          workspaceId={id}
          workspaceName={driveName || "Drive"}
          selectedPath={selectedFile}
          onFileSelect={(path) => { setSelectedFile(path); setViewerOpen(true); }}
          onDeletedPaths={(paths) => {
            if (selectedFile && paths.includes(selectedFile)) { setSelectedFile(null); setViewerOpen(false); }
            refreshTree();
          }}
          refreshKey={treeRefreshKey}
          style={{ width: leftWidth, borderRight: "1px solid var(--color-border)" }}
        />
        <div
          className="w-[5px] cursor-col-resize flex-shrink-0 hover:bg-primary-soft"
          onMouseDown={() => { colDragging.current = true; setIsDragging(true); }}
        />
        <div className="flex-1 min-w-0 flex flex-col bg-bg">
          {viewerOpen ? (
            <FileViewer
              ref={viewerRef}
              apiBase={apiBase}
              enableHtmlPreview={false}
              workspaceId={id}
              filePath={selectedFile}
              onClose={() => { setViewerOpen(false); setSelectedFile(null); }}
              onSelfWrite={refreshTree}
            />
          ) : (
            <div className="flex-1 grid place-items-center text-text-3 text-sm p-6 text-center">
              Select a file from the tree to view its contents
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
