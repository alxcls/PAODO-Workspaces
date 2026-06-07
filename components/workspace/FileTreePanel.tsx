// Left sidebar showing the workspace file tree with expandable directories and multi-select checkboxes.
// Supports file and folder upload, ZIP download of selected files, and bulk delete.
// Re-fetches the tree whenever the refreshKey prop changes (triggered by agent file mutations).
"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import JSZip from "jszip";
import { useRouter } from "next/navigation";
import { isExecutable } from "@/lib/utils/fileType";

interface TreeNode {
  name: string;
  type: "file" | "directory";
  path: string;
  permission?: "R" | "RW";
  privileged?: boolean;
  hidden?: boolean;
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

// ---- Permission badge ----
const PermBadge = ({
  node, workspaceId, wsDir, onRefresh, onPermissionChange,
}: {
  node: TreeNode; workspaceId: string; wsDir: string;
  onRefresh: () => void; onPermissionChange: (path: string, perm: "R" | "RW") => void;
}) => {
  const [busy, setBusy] = useState(false);
  const perm = node.permission ?? "RW";

  const toggle = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (busy) return;
    setBusy(true);
    const next: "R" | "RW" = perm === "R" ? "RW" : "R";
    const relPath = node.path.startsWith(wsDir)
      ? node.path.slice(wsDir.length).replace(/^\//, "")
      : node.path;
    try {
      const res = await fetch(`/api/workspaces/${workspaceId}/permissions`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: relPath, permission: next }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      onPermissionChange(node.path, next);
      onRefresh();
    } finally {
      setBusy(false);
    }
  };

  const title = perm === "R" ? "Read-only — click to unlock" : "Read-write — click to lock";

  return (
    <span
      className="flex-shrink-0 inline-flex items-center justify-center w-[18px] h-[18px] rounded-[3px] cursor-pointer select-none ml-1 hover:bg-black/[.12] transition-colors"
      onClick={toggle}
      title={title}
      style={{ opacity: busy ? 0.4 : undefined, color: perm === "R" ? "#7c3aed" : "var(--color-text-3)" }}
    >
      {perm === "R" ? (
        <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect width="18" height="11" x="3" y="11" rx="2" ry="2" />
          <path d="M7 11V7a5 5 0 0 1 10 0v4" />
        </svg>
      ) : (
        <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect width="18" height="11" x="3" y="11" rx="2" ry="2" />
          <path d="M7 11V7a5 5 0 0 1 9.9-1" />
        </svg>
      )}
    </span>
  );
};

// ---- Key badge ----
// Granting privilege authorizes a script to run with workspace secrets and auto-locks it (server-side).
// Revoking privilege is metadata-only — the lock stays. Unlocking a privileged file auto-revokes privilege.
const KeyBadge = ({
  node, workspaceId, wsDir, onRefresh,
}: {
  node: TreeNode; workspaceId: string; wsDir: string; onRefresh: () => void;
}) => {
  const [busy, setBusy] = useState(false);
  const privileged = node.privileged ?? false;

  const toggle = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (busy) return;
    setBusy(true);
    const relPath = node.path.startsWith(wsDir)
      ? node.path.slice(wsDir.length).replace(/^\//, "")
      : node.path;
    try {
      const res = await fetch(`/api/workspaces/${workspaceId}/privileged-scripts`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: relPath, keyed: !privileged }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      onRefresh();
    } finally {
      setBusy(false);
    }
  };

  return (
    <span
      className="flex-shrink-0 inline-flex items-center justify-center w-[18px] h-[18px] rounded-[3px] cursor-pointer select-none ml-1 hover:bg-black/[.12] transition-colors"
      onClick={toggle}
      title={privileged ? "Privileged — runs with secrets injected. Click to revoke." : "Grant privilege — let this script run with secrets (locks it so it can't be tampered with)."}
      style={{ opacity: busy ? 0.4 : 1, color: privileged ? "#7c3aed" : "var(--color-text-3)" }}
    >
      <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="7.5" cy="12" r="4.5" />
        <line x1="12" y1="12" x2="22" y2="12" />
        <line x1="19" y1="12" x2="19" y2="15" />
        <line x1="17" y1="12" x2="17" y2="14" />
      </svg>
    </span>
  );
};

// ---- Eye badge ----
// Hiding makes a file's CONTENT invisible to the agent (kernel-enforced root:app-group ownership)
// while the user still sees it here. Visibility is independent of lock and privilege.
const EyeBadge = ({
  node, workspaceId, wsDir, onRefresh,
}: {
  node: TreeNode; workspaceId: string; wsDir: string; onRefresh: () => void;
}) => {
  const [busy, setBusy] = useState(false);
  const hidden = node.hidden ?? false;

  const toggle = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (busy) return;
    setBusy(true);
    const relPath = node.path.startsWith(wsDir)
      ? node.path.slice(wsDir.length).replace(/^\//, "")
      : node.path;
    try {
      const res = await fetch(`/api/workspaces/${workspaceId}/hidden`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: relPath, hidden: !hidden }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      onRefresh();
    } finally {
      setBusy(false);
    }
  };

  return (
    <span
      className="flex-shrink-0 inline-flex items-center justify-center w-[18px] h-[18px] rounded-[3px] cursor-pointer select-none ml-1 hover:bg-black/[.12] transition-colors"
      onClick={toggle}
      title={hidden ? "Hidden — content invisible to the agent. Click to reveal." : "Visible — click to hide its content from the agent."}
      style={{ opacity: busy ? 0.4 : 1, color: hidden ? "#7c3aed" : "var(--color-text-3)" }}
    >
      {hidden ? (
        <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M9.88 9.88a3 3 0 0 0 4.24 4.24" />
          <path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68" />
          <path d="M6.61 6.61A13.526 13.526 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61" />
          <line x1="2" y1="2" x2="22" y2="22" />
        </svg>
      ) : (
        <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z" />
          <circle cx="12" cy="12" r="3" />
        </svg>
      )}
    </span>
  );
};

// ---- Master lock button ----
const MasterLockButton = ({
  workspaceId, globalLock, onRefresh, onGlobalPermissionChange,
}: {
  workspaceId: string; globalLock: boolean;
  onRefresh: () => void; onGlobalPermissionChange: (perm: "R" | "RW") => void;
}) => {
  const [busy, setBusy] = useState(false);

  const toggle = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (busy) return;
    setBusy(true);
    const next: "R" | "RW" = globalLock ? "RW" : "R";
    try {
      const res = await fetch(`/api/workspaces/${workspaceId}/permissions`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ permission: next }),
      });
      if (!res.ok) throw new Error(await res.text());
      onGlobalPermissionChange(next);
      onRefresh();
    } catch (err) {
      console.error("failed to toggle global lock", err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <button
      className="iconbtn"
      onClick={toggle}
      title={globalLock ? "Workspace locked — click to unlock all" : "Click to lock all files"}
      style={{ opacity: busy ? 0.4 : 1 }}
    >
      {globalLock ? (
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect width="18" height="11" x="3" y="11" rx="2" ry="2" />
          <path d="M7 11V7a5 5 0 0 1 10 0v4" />
        </svg>
      ) : (
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect width="18" height="11" x="3" y="11" rx="2" ry="2" />
          <path d="M7 11V7a5 5 0 0 1 9.9-1" />
        </svg>
      )}
    </button>
  );
};

// ---- Tree node list ----
interface TreeListProps {
  nodes: TreeNode[]; depth: number; expanded: Record<string, boolean>;
  onToggle: (path: string) => void; activePath: string | null;
  selected: Set<string>; onSelect: (paths: string[], on: boolean) => void;
  onPick: (path: string, permission: "R" | "RW") => void;
  workspaceId: string; wsDir: string; onRefresh: () => void;
  onPermissionChange: (path: string, perm: "R" | "RW") => void;
}

const TreeNodeList = ({
  nodes, depth, expanded, onToggle, activePath, selected,
  onSelect, onPick, workspaceId, wsDir, onRefresh, onPermissionChange,
}: TreeListProps) => {
  const sorted = [...nodes].sort((a, b) => {
    if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  return (
    <>
      {sorted.map((node) => {
        const canHide = !isExecutable(node.name) && !node.privileged;
        const canKey  = node.type === "directory" || isExecutable(node.name) || (node.privileged ?? false);
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
                  <>
                    {canHide && (
                      <EyeBadge node={node} workspaceId={workspaceId} wsDir={wsDir} onRefresh={onRefresh} />
                    )}
                    {canKey && <KeyBadge node={node} workspaceId={workspaceId} wsDir={wsDir} onRefresh={onRefresh} />}
                    <PermBadge node={node} workspaceId={workspaceId} wsDir={wsDir} onRefresh={onRefresh} onPermissionChange={onPermissionChange} />
                  </>
                </div>
              </button>
              {isOpen && node.children && (
                <TreeNodeList
                  nodes={node.children} depth={depth + 1} expanded={expanded}
                  onToggle={onToggle} activePath={activePath} selected={selected}
                  onSelect={onSelect} onPick={onPick}
                  workspaceId={workspaceId} wsDir={wsDir} onRefresh={onRefresh}
                  onPermissionChange={onPermissionChange}
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
            onClick={() => onPick(node.path, node.permission ?? "RW")}
          >
            <Checkbox
              state={isSel ? "all" : "none"}
              onClick={(e) => { e.stopPropagation(); onSelect([node.path], !isSel); }}
            />
            <div className="flex items-center gap-1.5 flex-1 min-w-0 overflow-hidden" style={{ marginLeft: 6 + depth * 14 + 14 }}>
              <span className={`inline-flex flex-shrink-0 ${isActive ? "text-primary" : "text-text-2"}`}><FileIcon /></span>
              <span className="flex-1 whitespace-nowrap overflow-hidden text-ellipsis">{node.name}</span>
              <>
                {canHide && (
                  <EyeBadge node={node} workspaceId={workspaceId} wsDir={wsDir} onRefresh={onRefresh} />
                )}
                {canKey && <KeyBadge node={node} workspaceId={workspaceId} wsDir={wsDir} onRefresh={onRefresh} />}
                <PermBadge node={node} workspaceId={workspaceId} wsDir={wsDir} onRefresh={onRefresh} onPermissionChange={onPermissionChange} />
              </>
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
  workspaceId: string; workspaceName: string; wsDir: string;
  selectedPath: string | null;
  onFileSelect: (path: string, permission: "R" | "RW") => void;
  onPermissionChange?: (path: string | null, perm: "R" | "RW") => void;
  onDeletedPaths?: (paths: string[]) => void;
  style?: React.CSSProperties; refreshKey?: number;
}

export default function FileTreePanel({
  workspaceId, workspaceName, wsDir, selectedPath,
  onFileSelect, onPermissionChange, onDeletedPaths, style, refreshKey,
}: Props) {
  const router = useRouter();
  const [tree, setTree] = useState<TreeNode[]>([]);
  const [globalLock, setGlobalLock] = useState(false);
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
      const { tree: data, globalLock: gl } = (await res.json()) as { tree: TreeNode[]; globalLock: boolean };
      setTree(data);
      setGlobalLock(gl);
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

  return (
    <aside className="flex flex-col bg-bg-tint overflow-hidden" style={style}>
      <div className="flex items-center gap-2 p-[14px_14px_8px]">
        <button className="iconbtn" onClick={() => router.push("/")} title="Back to workspaces">
          <BackIcon />
        </button>
        <span className="font-semibold text-[15px] tracking-[-0.01em] whitespace-nowrap overflow-hidden text-ellipsis flex-1" title={workspaceName}>
          {workspaceName}
        </span>
        <MasterLockButton
          workspaceId={workspaceId} globalLock={globalLock} onRefresh={fetchTree}
          onGlobalPermissionChange={(perm) => onPermissionChange?.(null, perm)}
        />
      </div>

      <div className="flex gap-1.5 px-3 pb-2.5 border-b border-border">
        <UploadMenu workspaceId={workspaceId} onUploaded={fetchTree} />
      </div>

      <div className="flex-1 overflow-auto py-2">
        <TreeNodeList
          nodes={tree} depth={0} expanded={expanded} onToggle={toggleExpanded}
          activePath={selectedPath} selected={selected} onSelect={handleSelect}
          onPick={onFileSelect} workspaceId={workspaceId} wsDir={wsDir}
          onRefresh={fetchTree}
          onPermissionChange={(path, perm) => onPermissionChange?.(path, perm)}
        />
      </div>

      {(selected.size > 0 || deleteError) && (
        <div className="border-t border-border p-[10px_12px] bg-bg">
          <div className="flex gap-1">
            <button
              className="btn btn-ghost btn-sm flex-1 justify-center"
              onClick={async () => {
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
              }}
            >
              Download .zip
            </button>
            <button
              className="btn btn-ghost btn-sm flex-1 justify-center text-danger"
                onClick={async () => {
                  const paths = Array.from(selected);
                  const roots = paths.filter(
                    p => !paths.some(other => other !== p && p.startsWith(other + "/"))
                  );
                setDeleteError(null);
                let failures: string[] = [];
                try {
                  const resArr = await Promise.all(
                    roots.map((p) =>
                      fetch(`/api/workspaces/${workspaceId}/files/content?path=${encodeURIComponent(p)}`, { method: "DELETE" })
                    )
                  );

                  for (let i = 0; i < resArr.length; i++) {
                    const r = resArr[i];
                    if (!r.ok) {
                      const body = await r.json().catch(() => ({} as any));
                      const msg = (body && (body.error || body.message)) || `${r.status} ${r.statusText}`;
                      // Do not include the path in the UI message — only show the reason
                      failures.push(msg);
                    }
                  }

                  if (failures.length > 0) {
                    const uniq = Array.from(new Set(failures));
                    // Single-line if one reason, otherwise join by "; "
                    const message = uniq.length === 1 ? `Failed to delete: ${uniq[0]}` : `Failed to delete: ${uniq.join('; ')}`;
                    setDeleteError(message);
                  } else {
                    setDeleteError(null);
                  }
                } catch (err) {
                  setDeleteError(err instanceof Error ? err.message : String(err));
                }

                if (failures.length === 0) {
                  setSelected(new Set());
                  onDeletedPaths?.(paths);
                }
                // Always refresh the tree so the UI reflects successful deletions
                fetchTree();
              }}
              >
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
