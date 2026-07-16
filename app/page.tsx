"use client";

import Image from "next/image";
import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import DescriptionBlock from "@/components/home/DescriptionBlock";
import ApiAccessBlock from "@/components/home/ApiAccessBlock";
import AgentLoopBlock from "@/components/home/AgentLoopBlock";
import ModelBlock from "@/components/home/ModelBlock";
import EnvVarsBlock from "@/components/home/EnvVarsBlock";
import McpBlock from "@/components/home/McpBlock";
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
    return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  } catch {
    return "—";
  }
}

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
  const [graphEnabled, setGraphEnabled] = useState(false);

  const fetchWorkspaces = useCallback(async () => {
    const res = await fetch("/api/workspaces");
    if (res.ok) setWorkspaces((await res.json()) as WorkspaceItem[]);
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/workspaces")
      .then(async (res) => {
        if (!res.ok) return;
        const items = (await res.json()) as WorkspaceItem[];
        if (!cancelled) setWorkspaces(items);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    fetch("/api/config")
      .then((r) => r.json())
      .then((cfg) => setGraphEnabled(cfg.graphEnabled ?? false))
      .catch(() => {});
  }, []);

  const selected = workspaces.find((w) => w.id === selectedId);

  useEffect(() => {
    if (!selectedId) return;
    let cancelled = false;
    fetch(`/api/workspaces/${selectedId}/files`)
      .then((r) => r.json())
      .then((data) => {
        if (!cancelled) setFileCount(countFiles((data as { tree: TreeNode[] }).tree ?? []));
      })
      .catch(() => {
        if (!cancelled) setFileCount(0);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedId]);

  useEffect(() => {
    if (!selectedId) return;
    let cancelled = false;
    fetch(`/api/workspaces/${selectedId}`)
      .then((r) => r.json())
      .then((ws: { description?: string }) => {
        if (!cancelled) setDescription(ws.description ?? "");
      })
      .catch(() => {
        if (!cancelled) setDescription("");
      });
    return () => {
      cancelled = true;
    };
  }, [selectedId]);

  const handleDescriptionChange = async (next: string) => {
    if (!selectedId) return;
    const previous = description;
    const normalized = next.trim();
    setDescription(normalized);
    const res = await fetch(`/api/workspaces/${selectedId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ description: next }),
    });
    if (!res.ok) setDescription(previous);
  };

  const handleSelect = (id: string) => {
    if (id !== selectedId) {
      setFileCount(null);
      setDescription("");
    }
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
        setFileCount(null);
        setDescription("");
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
    if (selectedId === id) {
      setSelectedId(null);
      setFileCount(null);
      setDescription("");
    }
    setConfirmDeleteId(null);
    await fetchWorkspaces();
  };

  return (
    <div className="flex flex-col h-screen">
      <TopBar
        left={
          <div className="flex items-center gap-2">
            <div className="w-[34px] h-[34px] rounded-[10px] overflow-hidden flex-shrink-0 inline-flex items-center justify-center bg-gradient-to-br from-primary to-primary-2">
              <Image
                src="/paodo-logo.svg"
                alt="Paodo logo"
                width={34}
                height={34}
                className="block w-full h-full object-cover"
                unoptimized
              />
            </div>
            <span className="font-semibold tracking-[-0.01em] text-lg leading-none inline-flex items-center">
              PAODO WS agents
            </span>
          </div>
        }
        right={
          <div className="flex items-center gap-1">
            <button
              className="btn btn-ghost text-ms gap-1.5 text-text-2 hover:text-primary"
              onClick={() => router.push("/dashboard")}
              title="Usage Dashboard"
            >
              <svg width="15" height="15" viewBox="0 0 15 15" fill="none">
                <rect x="1" y="9" width="3" height="5" rx="0.5" fill="currentColor" />
                <rect x="6" y="5" width="3" height="9" rx="0.5" fill="currentColor" />
                <rect x="11" y="2" width="3" height="12" rx="0.5" fill="currentColor" />
              </svg>
              Dashboard
            </button>
            {graphEnabled ? (
              <button
                className="btn btn-ghost text-ms gap-1.5 text-text-2 hover:text-primary"
                onClick={() => router.push("/graph")}
                title="Agent Network"
              >
                <svg width="15" height="15" viewBox="0 0 15 15" fill="none">
                  <circle cx="2.5" cy="7.5" r="2" stroke="currentColor" strokeWidth="1.3" />
                  <circle cx="12.5" cy="3" r="2" stroke="currentColor" strokeWidth="1.3" />
                  <circle cx="12.5" cy="12" r="2" stroke="currentColor" strokeWidth="1.3" />
                  <line
                    x1="4.4"
                    y1="6.5"
                    x2="10.6"
                    y2="3.6"
                    stroke="currentColor"
                    strokeWidth="1.3"
                    strokeLinecap="round"
                  />
                  <line
                    x1="4.4"
                    y1="8.5"
                    x2="10.6"
                    y2="11.4"
                    stroke="currentColor"
                    strokeWidth="1.3"
                    strokeLinecap="round"
                  />
                </svg>
                Network
              </button>
            ) : null}
          </div>
        }
      />

      <div className="flex flex-1 min-h-0 bg-bg">
        {/* Sidebar */}
        <aside className="w-[260px] flex-none min-h-0 h-full overflow-hidden bg-bg-tint border-r border-border p-[20px_16px_24px] flex flex-col gap-3">
          <button
            className={"btn btn-primary btn-block flex-none" + (showCreateForm ? " is-active" : "")}
            onClick={() => setShowCreateForm(true)}
          >
            <span className="font-semibold">+</span> New workspace
          </button>

          {showCreateForm && (
            <div
              className="flex-none bg-white border border-border rounded-card p-2.5 flex flex-col gap-2 shadow-sm"
              onClick={(e) => e.stopPropagation()}
            >
              <input
                autoFocus
                className="input"
                placeholder="Workspace name"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && newName.trim()) handleCreate();
                  if (e.key === "Escape") {
                    setShowCreateForm(false);
                    setNewName("");
                  }
                }}
              />
              <div className="flex gap-2 items-center">
                <button
                  className="btn btn-primary btn-sm"
                  disabled={!newName.trim() || isCreating}
                  onClick={handleCreate}
                >
                  {isCreating ? "Creating…" : "Create"}
                </button>
                <button
                  className="linkbtn"
                  onClick={() => {
                    setShowCreateForm(false);
                    setNewName("");
                  }}
                >
                  Cancel
                </button>
              </div>
            </div>
          )}

          <div className="flex-none mt-2 text-2xs font-semibold text-text-3 tracking-[.08em] px-1.5 uppercase">
            Workspaces
          </div>
          <div className="workspace-list h-0 flex-1 min-h-0 overflow-y-scroll overscroll-contain flex flex-col gap-1 mr-[-16px] pr-2">
            {workspaces.length === 0 && (
              <div className="flex-none text-text-3 text-ms p-[8px_6px]">No workspaces yet</div>
            )}
            {workspaces.map((w) => (
              <button
                key={w.id}
                className={`flex-none flex items-center justify-between min-h-[34px] px-2.5 py-[7px] border-0 border-l-[3px] bg-transparent rounded-[4px] cursor-pointer text-left text-sm w-full transition-[background,border-color,color] duration-[120ms] overflow-hidden
                  ${
                    w.id === selectedId
                      ? "bg-primary-tint border-l-primary text-primary font-medium"
                      : "border-l-transparent text-text hover:bg-black/[.04]"
                  }`}
                onClick={() => handleSelect(w.id)}
              >
                <span className="overflow-hidden text-ellipsis whitespace-nowrap">{w.name}</span>
              </button>
            ))}
          </div>
        </aside>

        {/* Main panel */}
        <main className="flex-1 p-[48px_56px_64px] max-w-[760px] overflow-auto">
          {selected ? (
            <div className="flex flex-col">
              <div className="uppercase text-2xs tracking-[.12em] text-text-3 font-semibold">Workspace</div>

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
                  <button className="btn btn-primary" onClick={handleRename}>
                    Done
                  </button>
                  <button className="linkbtn" onClick={() => setRenaming(false)}>
                    Cancel
                  </button>
                </div>
              ) : (
                <h1 className="text-[34px] font-semibold tracking-[-0.02em] my-1.5 text-text">{selected.name}</h1>
              )}

              <div className="text-text-2 text-sm">
                Created {formatDate(selected.createdAt)}
                {fileCount !== null ? ` · ${fileCount} file${fileCount === 1 ? "" : "s"}` : ""}
              </div>

              <div className="flex gap-2.5 mt-7 mb-2">
                <button className="btn btn-primary btn-lg" onClick={() => router.push(`/workspace/${selected.id}`)}>
                  Open workspace <span className="font-semibold">→</span>
                </button>
                <button
                  className="btn btn-ghost btn-lg"
                  onClick={() => {
                    setRenameDraft(selected.name);
                    setRenaming(true);
                  }}
                >
                  Rename
                </button>
                <button className="btn btn-danger btn-lg" onClick={() => setConfirmDeleteId(selected.id)}>
                  Delete
                </button>
              </div>

              {confirmDeleteId === selected.id && (
                <div className="mt-2 p-[10px_14px] border border-danger bg-danger-soft rounded-card text-text flex items-center justify-between gap-3">
                  <span>
                    Delete <b>{selected.name}</b>? This can&apos;t be undone.
                  </span>
                  <div className="flex gap-2 items-center">
                    <button className="btn btn-danger btn-sm" onClick={() => handleDelete(selected.id)}>
                      Yes, delete
                    </button>
                    <button className="linkbtn" onClick={() => setConfirmDeleteId(null)}>
                      Cancel
                    </button>
                  </div>
                </div>
              )}

              <div className="mt-9 mb-2 text-xs font-semibold uppercase tracking-[.08em] text-text-3">Description</div>
              <DescriptionBlock key={selected.id} value={description} onChange={handleDescriptionChange} />
              <ApiAccessBlock key={selected.id} wsId={selected.id} />
              <McpBlock key={`mcp-${selected.id}`} wsId={selected.id} />
              <AgentLoopBlock key={`loop-${selected.id}`} wsId={selected.id} />
              <ModelBlock key={`model-${selected.id}`} wsId={selected.id} />
              <EnvVarsBlock key={`env-${selected.id}`} wsId={selected.id} />
            </div>
          ) : (
            <div className="mt-20 text-center text-text-2">
              <div className="empty-illo" />
              <h2 className="m-0 mb-1.5 text-lg text-text font-semibold">No workspace selected</h2>
              <p className="m-0">Pick a workspace on the left, or create a new one to get started.</p>
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
