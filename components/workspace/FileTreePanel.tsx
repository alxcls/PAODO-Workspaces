// Left sidebar showing the workspace file tree with expandable directories and multi-select checkboxes.
// Supports file and folder upload, ZIP download of selected files, and bulk delete.
// Re-fetches the tree whenever the refreshKey prop changes (triggered by agent file mutations).
"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import JSZip from "jszip";
import { useRouter } from "next/navigation";

interface TreeNode {
  name: string;
  type: "file" | "directory";
  path: string;
  children?: TreeNode[];
}

type CheckState = "none" | "some" | "all";

// ---- Icons ----
const BackIcon = () => (
  <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M19 12H5" /><path d="M12 19l-7-7 7-7" />
  </svg>
);
const UploadIcon = () => (
  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="17 8 12 3 7 8" /><line x1="12" y1="3" x2="12" y2="15" />
  </svg>
);
const FileIcon = () => (
  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14 2 14 8 20 8" />
  </svg>
);
const FolderIcon = () => (
  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
  </svg>
);
const ChevIcon = () => (
  <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="9 18 15 12 9 6" />
  </svg>
);

// ---- Helpers ----
function getAllNodes(nodes: TreeNode[]): TreeNode[] {
  return nodes.flatMap((n) => [n, ...getAllNodes(n.children ?? [])]);
}

function getNodeCheckState(node: TreeNode, selected: Set<string>): CheckState {
  if (selected.has(node.path)) return "all";
  if (node.type === "file") return "none";
  const anyDescendant = getAllNodes(node.children ?? []).some(n => selected.has(n.path));
  return anyDescendant ? "some" : "none";
}

// ---- Checkbox ----
const Checkbox = ({ state, onClick }: { state: CheckState; onClick: (e: React.MouseEvent) => void }) => (
  <span
    className={`w-[14px] h-[14px] rounded-[3px] inline-flex items-center justify-center flex-shrink-0 transition-[border-color,background] duration-[120ms] border-[1.4px] cursor-pointer
      ${state !== "none" ? "bg-select border-select text-white" : "bg-white border-border hover:border-select"}`}
    onClick={onClick}
    role="checkbox"
    aria-checked={state === "all" ? "true" : state === "some" ? "mixed" : "false"}
  >
    {state === "all" && (
      <svg viewBox="0 0 16 16" width="10" height="10" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
        <polyline points="3 9 6.5 12.5 13 4" />
      </svg>
    )}
    {state === "some" && (
      <svg viewBox="0 0 16 16" width="10" height="10" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
        <line x1="4" y1="8" x2="12" y2="8" />
      </svg>
    )}
  </span>
);

// ---- Tree node list ----
interface TreeListProps {
  nodes: TreeNode[]; depth: number; expanded: Record<string, boolean>;
  onToggle: (path: string) => void; activePath: string | null;
  selected: Set<string>; onSelect: (paths: string[], on: boolean) => void;
  onPick: (path: string) => void;
}

const TreeNodeList = ({
  nodes, depth, expanded, onToggle, activePath, selected,
  onSelect, onPick,
}: TreeListProps) => {
  const sorted = [...nodes].sort((a, b) => {
    if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  return (
    <>
      {sorted.map((node) => {
        if (node.type === "directory") {
          const isOpen = expanded[node.path] ?? false;
          const state = getNodeCheckState(node, selected);

          return (
            <div key={node.path}>
              <button
                className={`flex items-center w-full border-0 border-l-[3px] border-l-transparent bg-transparent py-[5px] pl-2 pr-2 text-[13.5px] text-text cursor-pointer text-left transition-[background,border-color,color] duration-[120ms] hover:bg-black/[.04] ${state !== "none" ? "bg-select-tint" : ""}`}
                onClick={() => onToggle(node.path)}
              >
                <Checkbox state={state} onClick={(e) => {
                  e.stopPropagation();
                  if (state !== "none") {
                    const descendants = getAllNodes(node.children ?? []).map(n => n.path);
                    onSelect([node.path, ...descendants], false);
                  } else {
                    onSelect([node.path], true);
                  }
                }} />
                <div className="flex items-center gap-1.5 flex-1 min-w-0 overflow-hidden" style={{ marginLeft: 6 + depth * 14 }}>
                  <span className={`inline-flex items-center justify-center w-3 h-3 flex-shrink-0 transition-transform duration-[150ms] text-text-3 ${isOpen ? "rotate-90" : ""}`}>
                    <ChevIcon />
                  </span>
                  <span className="text-text-2 inline-flex flex-shrink-0"><FolderIcon /></span>
                  <span className="flex-1 whitespace-nowrap overflow-hidden text-ellipsis">{node.name}</span>
                </div>
              </button>
              {isOpen && node.children && (
                <TreeNodeList
                  nodes={node.children} depth={depth + 1} expanded={expanded}
                  onToggle={onToggle} activePath={activePath} selected={selected}
                  onSelect={onSelect} onPick={onPick}
                />
              )}
            </div>
          );
        }

        const isActive = node.path === activePath;
        const isSel = selected.has(node.path);
        return (
          <button
            key={node.path}
            className={`flex items-center w-full border-0 border-l-[3px] bg-transparent py-[5px] pl-2 pr-2 text-[13.5px] cursor-pointer text-left transition-[background,border-color,color] duration-[120ms]
              ${isActive
                ? "bg-primary-tint border-l-primary text-primary"
                : `border-l-transparent text-text hover:bg-black/[.04] ${isSel ? "bg-select-tint" : ""}`
              }`}
            onClick={() => onPick(node.path)}
          >
            <Checkbox
              state={isSel ? "all" : "none"}
              onClick={(e) => { e.stopPropagation(); onSelect([node.path], !isSel); }}
            />
            <div className="flex items-center gap-1.5 flex-1 min-w-0 overflow-hidden" style={{ marginLeft: 6 + depth * 14 + 14 }}>
              <span className={`inline-flex flex-shrink-0 ${isActive ? "text-primary" : "text-text-2"}`}><FileIcon /></span>
              <span className="flex-1 whitespace-nowrap overflow-hidden text-ellipsis">{node.name}</span>
            </div>
          </button>
        );
      })}
    </>
  );
};

// ---- Upload button ----
const UploadMenu = ({ workspaceId, onUploaded }: { workspaceId: string; onUploaded: () => void }) => {
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Single files: send individually (small count, no need to archive)
  const uploadFiles = async (files: File[]) => {
    if (files.length === 0) return;
    setError(null);
    setStatus("Uploading…");
    try {
      const CONCURRENCY = 5;
      const queue = [...files];
      const worker = async () => {
        while (queue.length > 0) {
          const file = queue.shift()!;
          const res = await fetch(
            `/api/workspaces/${workspaceId}/files/upload?path=${encodeURIComponent(file.name)}`,
            { method: "POST", body: file }
          );
          if (!res.ok) throw new Error(`Failed to upload ${file.name}`);
        }
      };
      await Promise.all(Array.from({ length: Math.min(CONCURRENCY, files.length) }, worker));
      onUploaded();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setStatus(null);
    }
  };

  // Folder: pack everything into a single ZIP then POST once — avoids per-file request
  // storms that exhaust the rate limit and file-descriptor pool for 10k+ file trees.
  const uploadFolder = async (files: File[]) => {
    if (files.length === 0) return;
    setError(null);
    try {
      const zip = new JSZip();
      for (const file of files) {
        const entryPath = file.webkitRelativePath || file.name;
        zip.file(entryPath, file);
      }

      setStatus("Compressing 0%");
      const blob = await zip.generateAsync(
        { type: "blob", compression: "DEFLATE", compressionOptions: { level: 1 } },
        (meta) => setStatus(`Compressing ${Math.round(meta.percent)}%`)
      );

      setStatus("Uploading archive…");
      const res = await fetch(`/api/workspaces/${workspaceId}/files/upload`, {
        method: "POST",
        headers: { "Content-Type": "application/zip" },
        body: blob,
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error((body as { error?: string }).error ?? `Upload failed (${res.status})`);
      }
      onUploaded();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setStatus(null);
    }
  };

  const handleFiles = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    e.target.value = "";
    uploadFiles(files);
  };

  const handleFolder = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    e.target.value = "";
    uploadFolder(files);
  };

  const busy = status !== null;

  return (
    <div className="flex flex-col gap-1 flex-1">
      <div className="flex gap-1">
        <button
          type="button"
          className={`btn btn-ghost btn-sm flex-1 justify-center relative ${busy ? "pointer-events-none opacity-50" : ""}`}
        >
          <UploadIcon /><span>Files</span>
          <input
            type="file"
            multiple
            className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
            onChange={handleFiles}
          />
        </button>

        <button
          type="button"
          className={`btn btn-ghost btn-sm flex-1 justify-center relative ${busy ? "pointer-events-none opacity-50" : ""}`}
        >
          <UploadIcon /><span>Folder</span>
          <input
            type="file"
            multiple
            // @ts-expect-error — webkitdirectory is not in React's HTMLInputElement types
            webkitdirectory=""
            className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
            onChange={handleFolder}
          />
        </button>
      </div>
      {status && <div className="text-[11px] text-text-3 px-1">{status}</div>}
      {error && <div className="text-[11px] text-danger px-1">{error}</div>}
    </div>
  );
};

// ---- Main component ----
interface Props {
  workspaceId: string; workspaceName: string;
  selectedPath: string | null;
  onFileSelect: (path: string) => void;
  onDeletedPaths?: (paths: string[]) => void;
  style?: React.CSSProperties; refreshKey?: number;
}

export default function FileTreePanel({
  workspaceId, workspaceName, selectedPath,
  onFileSelect, onDeletedPaths, style, refreshKey,
}: Props) {
  const router = useRouter();
  const [tree, setTree] = useState<TreeNode[]>([]);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const deleteTimerRef = useRef<number | null>(null);

  useEffect(() => {
    if (!deleteError) return;
    // clear any existing timer
    if (deleteTimerRef.current) {
      clearTimeout(deleteTimerRef.current);
      deleteTimerRef.current = null;
    }
    // hide the error after 2 seconds
    deleteTimerRef.current = window.setTimeout(() => {
      setDeleteError(null);
      deleteTimerRef.current = null;
    }, 2000);
    return () => {
      if (deleteTimerRef.current) {
        clearTimeout(deleteTimerRef.current);
        deleteTimerRef.current = null;
      }
    };
  }, [deleteError]);

  const fetchTree = useCallback(async () => {
    try {
      const res = await fetch(`/api/workspaces/${workspaceId}/files`);
      if (!res.ok) return;
      const { tree: data } = (await res.json()) as { tree: TreeNode[] };
      setTree(data);
      setExpanded((prev) => Object.keys(prev).length > 0 ? prev : {});
    } catch { /* silent */ }
  }, [workspaceId]);

  useEffect(() => { fetchTree(); }, [fetchTree, refreshKey]);

  const toggleExpanded = (path: string) => setExpanded((e) => ({ ...e, [path]: !e[path] }));

  const handleSelect = (paths: string[], on: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev);
      for (const p of paths) on ? next.add(p) : next.delete(p);
      return next;
    });
  };

  async function handleDownload() {
    const res = await fetch(`/api/workspaces/${workspaceId}/files/download`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ paths: Array.from(selected) }),
    });
    if (!res.ok) return;
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `${workspaceName}.zip`; a.click();
    URL.revokeObjectURL(url);
  }

  async function handleDelete() {
    const paths = Array.from(selected);
    const roots = paths.filter(
      (p) => !paths.some((other) => other !== p && p.startsWith(other + "/"))
    );
    setDeleteError(null);
    const failures: string[] = [];
    try {
      const resArr = await Promise.all(
        roots.map((p) =>
          fetch(`/api/workspaces/${workspaceId}/files/content?path=${encodeURIComponent(p)}`, { method: "DELETE" })
        )
      );
      for (const r of resArr) {
        if (!r.ok) {
          const body = await r.json().catch(() => ({} as { error?: string; message?: string }));
          failures.push((body.error || body.message) ?? `${r.status} ${r.statusText}`);
        }
      }
      if (failures.length > 0) {
        const uniq = Array.from(new Set(failures));
        setDeleteError(uniq.length === 1 ? `Failed to delete: ${uniq[0]}` : `Failed to delete: ${uniq.join("; ")}`);
      }
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : String(err));
    }
    if (failures.length === 0) {
      setSelected(new Set());
      onDeletedPaths?.(paths);
    }
    fetchTree();
  }

  return (
    <aside className="flex flex-col bg-bg-tint overflow-hidden" style={style}>
      <div className="flex items-center gap-2 p-[14px_14px_8px]">
        <button className="iconbtn" onClick={() => router.push("/")} title="Back to workspaces">
          <BackIcon />
        </button>
        <span className="font-semibold text-[15px] tracking-[-0.01em] whitespace-nowrap overflow-hidden text-ellipsis flex-1" title={workspaceName}>
          {workspaceName}
        </span>
      </div>

      <div className="flex gap-1.5 px-3 pb-2.5 border-b border-border">
        <UploadMenu workspaceId={workspaceId} onUploaded={fetchTree} />
      </div>

      <div className="flex-1 overflow-auto py-2">
        <TreeNodeList
          nodes={tree} depth={0} expanded={expanded} onToggle={toggleExpanded}
          activePath={selectedPath} selected={selected} onSelect={handleSelect}
          onPick={onFileSelect}
        />
      </div>

      {(selected.size > 0 || deleteError) && (
        <div className="border-t border-border p-[10px_12px] bg-bg">
          <div className="flex gap-1">
            <button className="btn btn-ghost btn-sm flex-1 justify-center" onClick={handleDownload}>
              Download .zip
            </button>
            <button className="btn btn-ghost btn-sm flex-1 justify-center text-danger" onClick={handleDelete}>
              Delete
            </button>
          </div>
          {deleteError && (
            <div className="text-[12px] text-danger whitespace-pre-wrap mt-2 px-1">{deleteError}</div>
          )}
        </div>
      )}
    </aside>
  );
}
