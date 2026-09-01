"use client";

import Image from "next/image";
import { useState } from "react";
import { useRouter } from "next/navigation";
import DescriptionBlock from "@/components/home/DescriptionBlock";
import ApiAccessBlock from "@/components/home/ApiAccessBlock";
import AgentLoopBlock from "@/components/home/AgentLoopBlock";
import ModelBlock from "@/components/home/ModelBlock";
import EnvVarsBlock from "@/components/home/EnvVarsBlock";
import McpBlock from "@/components/home/McpBlock";
import InternetAccessBlock from "@/components/home/InternetAccessBlock";
import SettingsModal from "@/components/settings/SettingsModal";
import TopBar from "@/components/layout/TopBar";
import { useWorkspaces } from "@/lib/client/hooks/useWorkspaces";
import { useWorkspaceDescription } from "@/lib/client/hooks/useWorkspaceDescription";
import { useWorkspaceInternetAccess } from "@/lib/client/hooks/useWorkspaceInternetAccess";
import { useWorkspaceMeta } from "@/lib/client/hooks/useWorkspaceMeta";
import { useWorkspaceStorage } from "@/lib/client/hooks/useWorkspaceStorage";
import { formatBytes } from "@/lib/uploads/limits";

function formatDate(iso: string) {
  try {
    return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  } catch {
    return "—";
  }
}

export default function HomePage() {
  const router = useRouter();
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const { workspaces, isCreating, create, rename, remove } = useWorkspaces();
  const selectedDetails = useWorkspaceMeta(selectedId);
  const selectedStorage = useWorkspaceStorage(selectedId);
  const { description, save: saveDescription } = useWorkspaceDescription(selectedId);
  const { enabled: internetAccess, toggle: toggleInternetAccess } = useWorkspaceInternetAccess(selectedId);

  // Form-local UI state: drafts and inline errors that live and die with the open form.
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [newName, setNewName] = useState("");
  const [createError, setCreateError] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [renameDraft, setRenameDraft] = useState("");
  const [renameError, setRenameError] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  // Bumped when Settings closes, to re-read the model catalog. Provider API keys are edited in there,
  // and `hasKey` is what decides whether ModelBlock warns that this workspace cannot run — so adding
  // or removing a key from the modal invalidates a catalog that was read when the page loaded.
  // Closing is the trigger rather than each individual save: the modal covers the block, so the
  // warning is only observable once it is shut, and one read on close costs less than tracking which
  // section changed.
  const [catalogVersion, setCatalogVersion] = useState(0);

  const selected = workspaces.find((w) => w.id === selectedId);

  // Description and file count reset themselves on every id change, so selecting only has to
  // move the selection and close whatever was open for the previous workspace.
  const handleSelect = (id: string) => {
    setSelectedId(id);
    setConfirmDeleteId(null);
    setRenaming(false);
    setRenameError(null);
  };

  const handleCreate = async () => {
    const name = newName.trim() || `workspace-${workspaces.length + 1}`;
    setCreateError(null);
    const result = await create(name);
    if (!result.ok) {
      // Keep the form open so the user can fix the name (e.g. a duplicate or invalid name).
      setCreateError(result.error);
      return;
    }
    setNewName("");
    setShowCreateForm(false);
    setSelectedId(result.workspace.id);
  };

  const handleRename = async () => {
    if (!selectedId || !renameDraft.trim()) return;
    setRenameError(null);
    const result = await rename(selectedId, renameDraft.trim());
    if (!result.ok) {
      // Keep the rename input open so the user can correct the name.
      setRenameError(result.error);
      return;
    }
    setRenaming(false);
  };

  const handleDelete = async (id: string) => {
    if (selectedId === id) setSelectedId(null);
    setConfirmDeleteId(null);
    await remove(id);
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
              PAODO Workspace agents
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
            <button
              className="btn btn-ghost text-ms gap-1.5 text-text-2 hover:text-primary"
              onClick={() => router.push("/graph")}
              title="Agent Graph"
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
              Graph
            </button>
            <button className="iconbtn" onClick={() => setShowSettings(true)} title="Settings" aria-label="Settings">
              <svg width="17" height="17" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path
                  d="M12 15.25A3.25 3.25 0 1 0 12 8.75a3.25 3.25 0 0 0 0 6.5Z"
                  stroke="currentColor"
                  strokeWidth="1.7"
                />
                <path
                  d="M19.4 13.5a7.8 7.8 0 0 0 0-3l2-1.55-2-3.46-2.47 1a8.2 8.2 0 0 0-2.6-1.5L14 2.35h-4l-.34 2.64a8.2 8.2 0 0 0-2.6 1.5l-2.46-1-2 3.46 2 1.55a7.8 7.8 0 0 0 0 3l-2 1.55 2 3.46 2.47-1a8.2 8.2 0 0 0 2.6 1.5l.33 2.64h4l.34-2.64a8.2 8.2 0 0 0 2.6-1.5l2.46 1 2-3.46-2-1.55Z"
                  stroke="currentColor"
                  strokeWidth="1.7"
                  strokeLinejoin="round"
                />
              </svg>
            </button>
          </div>
        }
      />
      <SettingsModal
        open={showSettings}
        onClose={() => {
          setShowSettings(false);
          setCatalogVersion((version) => version + 1);
        }}
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
                onChange={(e) => {
                  setNewName(e.target.value);
                  if (createError) setCreateError(null);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && newName.trim()) handleCreate();
                  if (e.key === "Escape") {
                    setShowCreateForm(false);
                    setNewName("");
                    setCreateError(null);
                  }
                }}
              />
              {createError && (
                <div role="alert" className="text-xs text-danger">
                  {createError}
                </div>
              )}
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
                    setCreateError(null);
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
        <main className="flex-1 min-w-0 overflow-auto">
          <div className="max-w-[760px] p-[48px_56px_64px]">
            {selected ? (
              <div className="flex flex-col">
                <div className="uppercase text-2xs tracking-[.12em] text-text-3 font-semibold">Workspace</div>

                {renaming ? (
                  <div style={{ margin: "6px 0 6px" }}>
                    <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                      <input
                        autoFocus
                        className="input"
                        style={{ fontSize: 20, fontWeight: 600, height: 44 }}
                        value={renameDraft}
                        onChange={(e) => {
                          setRenameDraft(e.target.value);
                          if (renameError) setRenameError(null);
                        }}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") handleRename();
                          if (e.key === "Escape") {
                            setRenaming(false);
                            setRenameError(null);
                          }
                        }}
                      />
                      <button className="btn btn-primary" onClick={handleRename}>
                        Done
                      </button>
                      <button
                        className="linkbtn"
                        onClick={() => {
                          setRenaming(false);
                          setRenameError(null);
                        }}
                      >
                        Cancel
                      </button>
                    </div>
                    {renameError && (
                      <div role="alert" className="text-xs text-danger mt-1">
                        {renameError}
                      </div>
                    )}
                  </div>
                ) : (
                  <h1 className="text-[34px] font-semibold tracking-[-0.02em] my-1.5 text-text">{selected.name}</h1>
                )}

                {/* Rendered only once both the date and the size are loaded, so they appear together
                    rather than the size popping in after the date; min-height reserves the line. */}
                <div className="text-text-2 text-sm min-h-5">
                  {selectedDetails && selectedStorage && (
                    <>
                      Created {formatDate(selectedDetails.createdAt)}
                      {" · "}
                      <span
                        title={`Files ${formatBytes(selectedStorage.breakdown.workspace)} · Deps ${formatBytes(
                          selectedStorage.breakdown.home,
                        )} · History ${formatBytes(selectedStorage.breakdown.versioning)}`}
                      >
                        {formatBytes(selectedStorage.bytes)} on disk
                      </span>
                    </>
                  )}
                </div>

                <div className="flex gap-2.5 mt-7 mb-2">
                  <button className="btn btn-primary btn-lg" onClick={() => router.push(`/workspace/${selected.id}`)}>
                    Open workspace <span className="font-semibold">→</span>
                  </button>
                  <button
                    className="btn btn-ghost btn-lg"
                    onClick={() => {
                      setRenameDraft(selected.name);
                      setRenameError(null);
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

                <div className="mt-9 mb-2 text-xs font-semibold uppercase tracking-[.08em] text-text-3">
                  Description
                </div>
                <DescriptionBlock key={`desc-${selected.id}`} value={description} onChange={saveDescription} />
                <ApiAccessBlock key={`api-${selected.id}`} wsId={selected.id} />
                <McpBlock key={`mcp-${selected.id}`} wsId={selected.id} />
                <AgentLoopBlock key={`loop-${selected.id}`} wsId={selected.id} />
                <ModelBlock key={`model-${selected.id}`} wsId={selected.id} catalogVersion={catalogVersion} />
                <InternetAccessBlock
                  key={`net-${selected.id}`}
                  enabled={internetAccess}
                  onToggle={toggleInternetAccess}
                />
                {internetAccess && <EnvVarsBlock key={`env-${selected.id}`} wsId={selected.id} />}
              </div>
            ) : (
              <div className="mt-20 text-center text-text-2">
                <div className="empty-illo" />
                <h2 className="m-0 mb-1.5 text-lg text-text font-semibold">No workspace selected</h2>
                <p className="m-0">Pick a workspace on the left, or create a new one to get started.</p>
              </div>
            )}
          </div>
        </main>
      </div>
    </div>
  );
}
