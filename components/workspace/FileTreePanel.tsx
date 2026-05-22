// Left sidebar showing the workspace file tree with expandable directories and multi-select checkboxes.
// Supports file and folder upload, ZIP download of selected files, and bulk delete.
// Re-fetches the tree whenever the refreshKey prop changes (triggered by agent file mutations).
"use client";

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";

interface TreeNode {
  name: string;
  type: "file" | "directory";
  path: string;
  permission?: "R" | "RW";
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
function getAllFilePaths(node: TreeNode): string[] {
  if (node.type === "file") return [node.path];
  return (node.children ?? []).flatMap(getAllFilePaths);
}

function getAllNodes(nodes: TreeNode[]): TreeNode[] {
  return nodes.flatMap((n) => [n, ...getAllNodes(n.children ?? [])]);
}

// ---- Checkbox ----
const Checkbox = ({
  state,
  onClick,
}: {
  state: CheckState;
  onClick: (e: React.MouseEvent) => void;
}) => (
  <span
    className={"tree-check" + (state !== "none" ? " tree-check-" + state : "")}
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
  node,
  workspaceId,
  wsDir,
  onRefresh,
}: {
  node: TreeNode;
  workspaceId: string;
  wsDir: string;
  onRefresh: () => void;
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
    await fetch(`/api/workspaces/${workspaceId}/permissions`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: relPath, permission: next }),
    });
    onRefresh();
    setBusy(false);
  };

  return (
    <span
      className="perm-badge"
      onClick={toggle}
      title={perm === "R" ? "Read-only — click to unlock" : "Read-write — click to lock"}
      style={{ opacity: busy ? 0.4 : 1 }}
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

// ---- Master lock button ----
const MasterLockButton = ({
  workspaceId,
  tree,
  onRefresh,
}: {
  workspaceId: string;
  tree: TreeNode[];
  onRefresh: () => void;
}) => {
  const [busy, setBusy] = useState(false);
  const allNodes = getAllNodes(tree).filter((n) => n.permission !== undefined);
  const allLocked = allNodes.length > 0 && allNodes.every((n) => n.permission === "R");

  const toggle = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (busy) return;
    setBusy(true);
    const next: "R" | "RW" = allLocked ? "RW" : "R";
    await fetch(`/api/workspaces/${workspaceId}/permissions`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ permission: next }),
    });
    onRefresh();
    setBusy(false);
  };

  return (
    <button
      className="iconbtn"
      onClick={toggle}
      title={allLocked ? "Workspace locked — click to unlock all" : "Click to lock all files"}
      style={{ opacity: busy ? 0.4 : 1 }}
    >
      {allLocked ? (
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
  nodes: TreeNode[];
  depth: number;
  expanded: Record<string, boolean>;
  onToggle: (path: string) => void;
  activePath: string | null;
  selected: Set<string>;
  onSelect: (paths: string[], on: boolean) => void;
  onPick: (path: string) => void;
  workspaceId: string;
  wsDir: string;
  onRefresh: () => void;
}

const TreeNodeList = ({
  nodes,
  depth,
  expanded,
  onToggle,
  activePath,
  selected,
  onSelect,
  onPick,
  workspaceId,
  wsDir,
  onRefresh,
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
          const childPaths = getAllFilePaths(node);
          const selectedCount = childPaths.filter((p) => selected.has(p)).length;
          const state: CheckState =
            selectedCount === 0
              ? "none"
              : selectedCount === childPaths.length
              ? "all"
              : "some";

          return (
            <div key={node.path}>
              <button
                className={"tree-row tree-folder" + (state !== "none" ? " is-selected" : "")}
                style={{ paddingLeft: 8 + depth * 14 }}
                onClick={() => onToggle(node.path)}
              >
                <Checkbox
                  state={state}
                  onClick={(e) => {
                    e.stopPropagation();
                    onSelect(childPaths, state !== "all");
                  }}
                />
                <span className={"chev" + (isOpen ? " is-open" : "")}>
                  <ChevIcon />
                </span>
                <span className="tree-icon">
                  <FolderIcon />
                </span>
                <span className="tree-name">{node.name}</span>
                <PermBadge node={node} workspaceId={workspaceId} wsDir={wsDir} onRefresh={onRefresh} />
              </button>
              {isOpen && node.children && (
                <TreeNodeList
                  nodes={node.children}
                  depth={depth + 1}
                  expanded={expanded}
                  onToggle={onToggle}
                  activePath={activePath}
                  selected={selected}
                  onSelect={onSelect}
                  onPick={onPick}
                  workspaceId={workspaceId}
                  wsDir={wsDir}
                  onRefresh={onRefresh}
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
            className={
              "tree-row tree-file" +
              (isActive ? " is-active" : "") +
              (isSel ? " is-selected" : "")
            }
            style={{ paddingLeft: 8 + depth * 14 + 14 }}
            onClick={() => onPick(node.path)}
          >
            <Checkbox
              state={isSel ? "all" : "none"}
              onClick={(e) => {
                e.stopPropagation();
                onSelect([node.path], !isSel);
              }}
            />
            <span className="tree-icon">
              <FileIcon />
            </span>
            <span className="tree-name">{node.name}</span>
            <PermBadge node={node} workspaceId={workspaceId} wsDir={wsDir} onRefresh={onRefresh} />
          </button>
        );
      })}
    </>
  );
};

// ---- Upload button ----
const UploadMenu = ({
  workspaceId,
  onUploaded,
}: {
  workspaceId: string;
  onUploaded: () => void;
}) => {
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const upload = async (files: File[], useRelativePath: boolean) => {
    if (files.length === 0) return;
    setError(null);
    setUploading(true);

    try {
      await Promise.all(files.map(async (file) => {
        const filePath = useRelativePath && file.webkitRelativePath
          ? file.webkitRelativePath
          : file.name;
        const res = await fetch(
          `/api/workspaces/${workspaceId}/files/upload?path=${encodeURIComponent(filePath)}`,
          { method: "POST", body: file }
        );
        if (!res.ok) throw new Error(`Failed to upload ${file.name}`);
      }));
      onUploaded();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setUploading(false);
    }
  };

  const handleFiles = (e: React.ChangeEvent<HTMLInputElement>, useRelativePath: boolean) => {
    const files = Array.from(e.target.files ?? []);
    e.target.value = "";
    upload(files, useRelativePath);
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <div style={{ display: "flex", gap: 4 }}>
        <label className="btn btn-ghost btn-sm" style={{ cursor: "pointer", flex: 1, justifyContent: "center", pointerEvents: uploading ? "none" : "auto", opacity: uploading ? 0.5 : 1 }}>
          <UploadIcon /><span>Files</span>
          <input type="file" multiple hidden onChange={(e) => handleFiles(e, false)} />
        </label>
        <label className="btn btn-ghost btn-sm" style={{ cursor: "pointer", flex: 1, justifyContent: "center", pointerEvents: uploading ? "none" : "auto", opacity: uploading ? 0.5 : 1 }}>
          <UploadIcon /><span>Folder</span>
          <input type="file" multiple hidden
            // @ts-expect-error — webkitdirectory is not in React's HTMLInputElement types
            webkitdirectory=""
            onChange={(e) => handleFiles(e, true)}
          />
        </label>
      </div>
      {uploading && (
        <div style={{ fontSize: 11, color: "var(--color-text-muted, #888)", padding: "2px 4px" }}>
          Uploading…
        </div>
      )}
      {error && (
        <div style={{ fontSize: 11, color: "var(--color-error, #e55)", padding: "2px 4px" }}>
          {error}
        </div>
      )}
    </div>
  );
};

// ---- Main component ----
interface Props {
  workspaceId: string;
  workspaceName: string;
  wsDir: string;
  selectedPath: string | null;
  onFileSelect: (path: string) => void;
  onDeletedPaths?: (paths: string[]) => void;
  style?: React.CSSProperties;
  refreshKey?: number;
}

export default function FileTreePanel({
  workspaceId,
  workspaceName,
  wsDir,
  selectedPath,
  onFileSelect,
  onDeletedPaths,
  style,
  refreshKey,
}: Props) {
  const router = useRouter();
  const [tree, setTree] = useState<TreeNode[]>([]);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const fetchTree = useCallback(async () => {
    try {
      const res = await fetch(`/api/workspaces/${workspaceId}/files`);
      if (!res.ok) return;
      const data = (await res.json()) as TreeNode[];
      setTree(data);
      setExpanded((prev) => {
        if (Object.keys(prev).length > 0) return prev;
        return {};
      });
    } catch { /* silent */ }
  }, [workspaceId]);

  useEffect(() => {
    fetchTree();
  }, [fetchTree, refreshKey]);

  const toggleExpanded = (path: string) =>
    setExpanded((e) => ({ ...e, [path]: !e[path] }));

  const handleSelect = (paths: string[], on: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev);
      for (const p of paths) on ? next.add(p) : next.delete(p);
      return next;
    });
  };

  return (
    <aside className="ws-left" style={style}>
      <div className="ws-left-head">
        <button className="iconbtn" onClick={() => router.push("/")} title="Back to workspaces">
          <BackIcon />
        </button>
        <span className="ws-name" title={workspaceName}>
          {workspaceName}
        </span>
        <MasterLockButton workspaceId={workspaceId} tree={tree} onRefresh={fetchTree} />
      </div>

      <div className="ws-upload-row">
        <UploadMenu workspaceId={workspaceId} onUploaded={fetchTree} />
      </div>

      <div className="tree">
        <TreeNodeList
          nodes={tree}
          depth={0}
          expanded={expanded}
          onToggle={toggleExpanded}
          activePath={selectedPath}
          selected={selected}
          onSelect={handleSelect}
          onPick={onFileSelect}
          workspaceId={workspaceId}
          wsDir={wsDir}
          onRefresh={fetchTree}
        />
      </div>

      {selected.size > 0 && (
        <div className="tree-selectbar">
          <div style={{ display: "flex", gap: 4 }}>
            <button
              className="btn btn-ghost btn-sm"
              style={{ flex: 1, justifyContent: "center" }}
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
                a.href = url;
                a.download = `${workspaceName}.zip`;
                a.click();
                URL.revokeObjectURL(url);
              }}
            >
              Download .zip
            </button>
            <button
              className="btn btn-ghost btn-sm"
              style={{ flex: 1, justifyContent: "center", color: "var(--danger)" }}
              onClick={async () => {
                const paths = Array.from(selected);
                await Promise.all(
                  paths.map((p) =>
                    fetch(`/api/workspaces/${workspaceId}/files/content?path=${encodeURIComponent(p)}`, { method: "DELETE" })
                  )
                );
                setSelected(new Set());
                fetchTree();
                onDeletedPaths?.(paths);
              }}
            >
              Delete selected
            </button>
          </div>
        </div>
      )}
    </aside>
  );
}
