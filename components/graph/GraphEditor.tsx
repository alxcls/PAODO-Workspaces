"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Background, BackgroundVariant, ConnectionMode, Controls, ReactFlow, type Node } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useRouter } from "next/navigation";
import Image from "next/image";
import TopBar from "@/components/layout/TopBar";
import { useTransientMessage } from "@/lib/client/hooks/useTransientMessage";
import { FloatingConnectionLine, FloatingEdge } from "./FloatingEdge";
import { DriveNode, WorkspaceNode } from "./GraphNodes";
import { SNAP_GRID } from "./grid";
import { useGraphDocument } from "./useGraphDocument";

export default function GraphEditor() {
  const router = useRouter();
  const nodeTypes = useMemo(() => ({ workspace: WorkspaceNode, drive: DriveNode }), []);
  const edgeTypes = useMemo(() => ({ floating: FloatingEdge }), []);
  const [error, showError] = useTransientMessage(3000);
  const [showUnsavedModal, setShowUnsavedModal] = useState(false);
  const [pendingDestination, setPendingDestination] = useState<string | null>(null);
  const [showDriveForm, setShowDriveForm] = useState(false);
  const [driveName, setDriveName] = useState("");
  const [driveDescription, setDriveDescription] = useState("");
  const onGraphDisabled = useCallback(() => router.replace("/"), [router]);
  const {
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
  } = useGraphDocument({ onGraphDisabled, showError });

  const guardedNavigate = useCallback(
    (destination: string) => {
      if (isDirty) {
        setPendingDestination(destination);
        setShowUnsavedModal(true);
      } else {
        router.push(destination);
      }
    },
    [isDirty, router],
  );

  const onNodeDoubleClick = useCallback(
    (_: React.MouseEvent, node: Node) => {
      guardedNavigate(node.data?.kind === "drive" ? `/drive/${node.id}` : `/workspace/${node.id}`);
    },
    [guardedNavigate],
  );

  const handleCreateDrive = useCallback(async () => {
    if (!(await createDrive(driveName, driveDescription))) return;
    setDriveName("");
    setDriveDescription("");
    setShowDriveForm(false);
  }, [createDrive, driveDescription, driveName]);

  const handleBack = useCallback(() => guardedNavigate("/"), [guardedNavigate]);

  const handleSaveAndLeave = useCallback(async () => {
    if (await save()) router.push(pendingDestination ?? "/");
  }, [pendingDestination, router, save]);

  // Browsers won't let JS cancel a popstate, so while dirty we keep re-planting a history
  // entry on top of the stack: Back always lands back on this same entry, which pops the
  // unsaved-changes modal instead of letting the navigation through.
  useEffect(() => {
    if (!isDirty) return;
    window.history.pushState(null, "", window.location.href);
    const handlePopState = () => {
      window.history.pushState(null, "", window.location.href);
      setPendingDestination(null);
      setShowUnsavedModal(true);
    };
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, [isDirty]);

  return (
    <div className="h-screen flex flex-col bg-bg-tint">
      <TopBar
        error={error}
        left={
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleBack}
              title="Back to workspaces"
              className="w-[34px] h-[34px] rounded-[10px] overflow-hidden flex-shrink-0 inline-flex items-center justify-center bg-gradient-to-br from-primary to-primary-2 border-0 p-0 cursor-pointer"
            >
              <Image
                src="/paodo-logo.svg"
                alt="Paodo logo"
                width={34}
                height={34}
                className="block w-full h-full object-cover"
                unoptimized
              />
            </button>
            <span className="font-semibold tracking-[-0.01em] text-lg leading-none inline-flex items-center">
              PAODO Workspace agents
            </span>
          </div>
        }
        right={
          <div className="flex items-center gap-2.5">
            {isDirty && <span className="text-xs text-text-3 italic">Unsaved changes</span>}
            <button className="btn btn-ghost btn-sm" onClick={() => setShowDriveForm((visible) => !visible)}>
              Add drive
            </button>
            {selection.label && (
              <button
                className="btn btn-ghost btn-sm text-danger"
                onClick={deleteSelection}
                title={`Delete ${selection.label}`}
              >
                Delete
              </button>
            )}
            <button className="btn btn-primary btn-sm" onClick={() => void save()} disabled={!isDirty}>
              {saved ? "Saved ✓" : "Save"}
            </button>
          </div>
        }
      />

      <div className="flex-1 min-h-0 relative">
        {showDriveForm && (
          <div className="absolute top-3 right-3 z-20 bg-white border border-border rounded-card p-3 shadow-md flex flex-col gap-2 w-[260px]">
            <div className="font-semibold text-sm text-text">New shared drive</div>
            <input
              autoFocus
              className="input"
              placeholder="Drive name (no spaces)"
              value={driveName}
              onChange={(event) => setDriveName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") void handleCreateDrive();
                if (event.key === "Escape") setShowDriveForm(false);
              }}
            />
            <textarea
              className="input resize-none"
              rows={3}
              placeholder="Description (optional)"
              value={driveDescription}
              onChange={(event) => setDriveDescription(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") setShowDriveForm(false);
              }}
            />
            <div className="flex gap-2 items-center">
              <button className="btn btn-primary btn-sm" onClick={() => void handleCreateDrive()}>
                Create
              </button>
              <button className="linkbtn" onClick={() => setShowDriveForm(false)}>
                Cancel
              </button>
            </div>
          </div>
        )}
        {ready && (
          <ReactFlow
            nodes={nodes}
            edges={edges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onNodeDragStart={onNodeDragStart}
            onNodeDragStop={onNodeDragStop}
            onNodeDoubleClick={onNodeDoubleClick}
            connectionMode={ConnectionMode.Loose}
            connectionLineComponent={FloatingConnectionLine}
            nodeTypes={nodeTypes}
            edgeTypes={edgeTypes}
            fitView
            fitViewOptions={{ padding: 0.3, maxZoom: 1 }}
            nodeDragThreshold={4}
            deleteKeyCode={null}
            multiSelectionKeyCode="Shift"
            snapToGrid
            snapGrid={SNAP_GRID}
          >
            <Background variant={BackgroundVariant.Dots} color="var(--color-border)" gap={24} size={1.2} />
            <Controls />
          </ReactFlow>
        )}
        {!ready && (
          <div className="absolute inset-0 flex items-center justify-center text-text-3 text-sm">
            Loading workspaces…
          </div>
        )}
      </div>

      {showUnsavedModal && (
        <div className="fixed inset-0 bg-[rgba(15,10,30,0.55)] flex items-center justify-center z-[1000]">
          <div className="bg-white rounded-2xl shadow-[0_18px_40px_rgba(15,10,30,0.25)] p-[30px_34px] w-[min(460px,calc(100vw-48px))] border border-[rgba(15,10,30,0.08)]">
            <div className="font-semibold text-[19px] mb-3 text-text">Unsaved changes</div>
            <p className="text-sm text-text-2 m-0 mb-[26px] leading-[1.5]">
              You have unsaved changes to the agent graph. What would you like to do?
              {pendingDriveDeletes.length > 0 && (
                <span className="block mt-2 text-danger">
                  Saving permanently deletes {pendingDriveDeletes.map((drive) => drive.data.label as string).join(", ")}
                  and everything stored in {pendingDriveDeletes.length > 1 ? "them" : "it"}.
                </span>
              )}
            </p>
            <div className="flex gap-2.5 items-center flex-wrap">
              <button className="btn btn-primary" onClick={() => void handleSaveAndLeave()}>
                Save &amp; leave
              </button>
              <button className="btn" onClick={() => router.push(pendingDestination ?? "/")}>
                Leave without saving
              </button>
              <button className="linkbtn" onClick={() => setShowUnsavedModal(false)}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
