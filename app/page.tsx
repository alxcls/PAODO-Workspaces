// Home page listing all workspaces with options to create or delete them.
// Also renders the description editor and API access panel for workspace-level configuration.
"use client";

import Image from "next/image";
import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import DescriptionBlock, { loadDesc } from "@/components/home/DescriptionBlock";
import ApiAccessBlock from "@/components/home/ApiAccessBlock";
import TopBar from "@/components/layout/TopBar";

interface WorkspaceItem {
  id: string;
  name: string;
  createdAt: string;
}

interface TreeNode {
  type: "file" | "directory";
  children?: TreeNode[];
}

function countFiles(nodes: TreeNode[]): number {
  let n = 0;
  for (const node of nodes) {
    if (node.type === "file") n++;
    else n += countFiles(node.children ?? []);
  }
  return n;
}

function formatDate(iso: string) {
  try {
    return new Date(iso).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  } catch {
    return "—";
  }
}

// ---- Main page ----
export default function HomePage() {
  const router = useRouter();
  const [workspaces, setWorkspaces] = useState<WorkspaceItem[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [newName, setNewName] = useState("");
  const [isCreating, setIsCreating] = useState(false);
  const [fileCount, setFileCount] = useState<number | null>(null);
  const [description, setDescription] = useState("");
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [renameDraft, setRenameDraft] = useState("");

  const fetchWorkspaces = useCallback(async () => {
    const res = await fetch("/api/workspaces");
    if (res.ok) setWorkspaces((await res.json()) as WorkspaceItem[]);
  }, []);

  useEffect(() => {
    fetchWorkspaces();
  }, [fetchWorkspaces]);

  const selected = workspaces.find((w) => w.id === selectedId);

  // Fetch file count when workspace changes
  useEffect(() => {
    if (!selectedId) { setFileCount(null); return; }
    setFileCount(null);
    fetch(`/api/workspaces/${selectedId}/files`)
      .then((r) => r.json())
      .then((data) => setFileCount(countFiles(data as TreeNode[])))
      .catch(() => setFileCount(0));
  }, [selectedId]);

  // Load description from localStorage when selection changes
  useEffect(() => {
    if (selectedId) setDescription(loadDesc(selectedId));
    else setDescription("");
  }, [selectedId]);

  const handleSelect = (id: string) => {
    setSelectedId(id);
    setConfirmDeleteId(null);
    setRenaming(false);
  };

  const handleCreate = async () => {
    const name = newName.trim() || `workspace-${workspaces.length + 1}`;
    setIsCreating(true);
    try {
      const res = await fetch("/api/workspaces", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      if (res.ok) {
        const ws = (await res.json()) as WorkspaceItem;
        setNewName("");
        setShowCreateForm(false);
        await fetchWorkspaces();
        setSelectedId(ws.id);
      }
    } finally {
      setIsCreating(false);
    }
  };

  const handleRename = async () => {
    if (!selectedId || !renameDraft.trim()) return;
    await fetch(`/api/workspaces/${selectedId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: renameDraft.trim() }),
    });
    setRenaming(false);
    await fetchWorkspaces();
  };

  const handleDelete = async (id: string) => {
    await fetch(`/api/workspaces/${id}`, { method: "DELETE" });
    if (selectedId === id) setSelectedId(null);
    setConfirmDeleteId(null);
    await fetchWorkspaces();
  };

  return (
    <div className="page-root">
      <TopBar
        left={
          <div className="brand">
            <div className="brand-mark">
              <Image src="/paodo-logo.svg" alt="Paodo logo" width={34} height={34} className="brand-logo" />
            </div>
            <span className="brand-name">PAODO WS agents</span>
          </div>
        }
        right={
          <button className="btn btn-ghost graph-nav-btn" onClick={() => router.push("/graph")} title="Agent Network">
            <svg width="15" height="15" viewBox="0 0 15 15" fill="none">
              <circle cx="2.5" cy="7.5" r="2" stroke="currentColor" strokeWidth="1.3" />
              <circle cx="12.5" cy="3" r="2" stroke="currentColor" strokeWidth="1.3" />
              <circle cx="12.5" cy="12" r="2" stroke="currentColor" strokeWidth="1.3" />
              <line x1="4.4" y1="6.5" x2="10.6" y2="3.6" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
              <line x1="4.4" y1="8.5" x2="10.6" y2="11.4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
            </svg>
            Network
          </button>
        }
      />
      <div className="selector">
      {/* Sidebar */}
      <aside className="selector-rail">
        <button
          className={"btn btn-primary btn-block" + (showCreateForm ? " is-active" : "")}
          onClick={() => setShowCreateForm(true)}
        >
          <span className="icon">+</span> New workspace
        </button>

        {showCreateForm && (
          <div className="create-form" onClick={(e) => e.stopPropagation()}>
            <input
              autoFocus
              className="input"
              placeholder="Workspace name"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && newName.trim()) handleCreate();
                if (e.key === "Escape") { setShowCreateForm(false); setNewName(""); }
              }}
            />
            <div className="create-actions">
              <button
                className="btn btn-primary btn-sm"
                disabled={!newName.trim() || isCreating}
                onClick={handleCreate}
              >
                {isCreating ? "Creating…" : "Create"}
              </button>
              <button
                className="linkbtn"
                onClick={() => { setShowCreateForm(false); setNewName(""); }}
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        <div className="rail-label">WORKSPACES</div>
        <div className="rail-list">
          {workspaces.length === 0 && (
            <div className="empty-rail">No workspaces yet</div>
          )}
          {workspaces.map((w) => (
            <button
              key={w.id}
              className={"rail-row" + (w.id === selectedId ? " is-active" : "")}
              onClick={() => handleSelect(w.id)}
            >
              <span className="rail-name">{w.name}</span>
            </button>
          ))}
        </div>
      </aside>

      {/* Main panel */}
      <main className="selector-main">
        {selected ? (
          <div className="ws-preview">
            <div className="ws-eyebrow">Workspace</div>

            {renaming ? (
              <div style={{ display: "flex", gap: 8, alignItems: "center", margin: "6px 0 6px" }}>
                <input
                  autoFocus
                  className="input"
                  style={{ fontSize: 20, fontWeight: 600, height: 44 }}
                  value={renameDraft}
                  onChange={(e) => setRenameDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") handleRename();
                    if (e.key === "Escape") setRenaming(false);
                  }}
                />
                <button className="btn btn-primary" onClick={handleRename}>Done</button>
                <button className="linkbtn" onClick={() => setRenaming(false)}>Cancel</button>
              </div>
            ) : (
              <h1 className="ws-title">{selected.name}</h1>
            )}

            <div className="ws-meta">
              Created {formatDate(selected.createdAt)}
              {fileCount !== null ? ` · ${fileCount} file${fileCount === 1 ? "" : "s"}` : ""}
            </div>

            <div className="ws-actions">
              <button
                className="btn btn-primary btn-lg"
                onClick={() => router.push(`/workspace/${selected.id}`)}
              >
                Open workspace <span className="icon">→</span>
              </button>
              <button
                className="btn btn-ghost btn-lg"
                onClick={() => { setRenameDraft(selected.name); setRenaming(true); }}
              >
                Rename
              </button>
              <button
                className="btn btn-danger btn-lg"
                onClick={() => setConfirmDeleteId(selected.id)}
              >
                Delete
              </button>
            </div>

            {confirmDeleteId === selected.id && (
              <div className="confirm-bar">
                <span>
                  Delete <b>{selected.name}</b>? This can&apos;t be undone.
                </span>
                <div>
                  <button
                    className="btn btn-danger btn-sm"
                    onClick={() => handleDelete(selected.id)}
                  >
                    Yes, delete
                  </button>
                  <button className="linkbtn" onClick={() => setConfirmDeleteId(null)}>
                    Cancel
                  </button>
                </div>
              </div>
            )}

            <div className="field-label">Description</div>
            <DescriptionBlock
              wsId={selected.id}
              value={description}
              onChange={setDescription}
            />
            <ApiAccessBlock key={selected.id} wsId={selected.id} />
          </div>
        ) : (
          <div className="empty-state">
            <div className="empty-illo" />
            <h2>No workspace selected</h2>
            <p>Pick a workspace on the left, or create a new one to get started.</p>
          </div>
        )}
      </main>
      </div>
    </div>
  );
}
