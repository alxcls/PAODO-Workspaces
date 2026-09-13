"use client";

// Composes the graph page: document state (useGraphDocument), the canvas, and the chrome around it.
import { useCallback, useState } from "react";
import type { Node } from "@xyflow/react";
import { useTransientMessage } from "@/lib/client/hooks/useTransientMessage";
import { AsyncState } from "@/components/shared/AsyncState";
import DriveForm from "./DriveForm";
import GraphCanvas from "./GraphCanvas";
import GraphTopBar from "./GraphTopBar";
import UnsavedChangesModal from "./UnsavedChangesModal";
import { isDriveNode } from "./types";
import { useGraphDocument } from "./useGraphDocument";
import { useNavigationGuard } from "./useNavigationGuard";

export default function GraphEditor() {
  const [error, showError] = useTransientMessage(3000);
  const [showDriveForm, setShowDriveForm] = useState(false);
  const {
    nodes,
    edges,
    ready,
    loadError,
    reload,
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
  } = useGraphDocument({ showError });
  const { guardedNavigate, isPrompting, leave, dismiss } = useNavigationGuard(isDirty);

  const onNodeDoubleClick = useCallback(
    (_: React.MouseEvent, node: Node) => {
      guardedNavigate(isDriveNode(node) ? `/drive/${node.id}` : `/workspace/${node.id}`);
    },
    [guardedNavigate],
  );

  const handleSaveAndLeave = useCallback(async () => {
    if (await save()) leave();
  }, [leave, save]);

  return (
    <div className="h-screen flex flex-col bg-bg-tint">
      <GraphTopBar
        error={error}
        isDirty={isDirty}
        saved={saved}
        selectionLabel={selection.label}
        onBack={() => guardedNavigate("/")}
        onAddDrive={() => setShowDriveForm((visible) => !visible)}
        onDeleteSelection={deleteSelection}
        onSave={() => void save()}
      />

      <div className="flex-1 min-h-0 relative">
        {showDriveForm && <DriveForm onCreate={createDrive} onClose={() => setShowDriveForm(false)} />}
        {ready && (
          <GraphCanvas
            nodes={nodes}
            edges={edges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onNodeDragStart={onNodeDragStart}
            onNodeDragStop={onNodeDragStop}
            onNodeDoubleClick={onNodeDoubleClick}
          />
        )}
        {!ready && (
          <AsyncState
            loading={!loadError}
            error={loadError}
            onRetry={reload}
            loadingLabel="Loading graph…"
            errorLabel="Couldn’t load the graph."
            className="absolute inset-0 text-sm"
          />
        )}
      </div>

      {isPrompting && (
        <UnsavedChangesModal
          pendingDriveDeletes={pendingDriveDeletes}
          onSaveAndLeave={() => void handleSaveAndLeave()}
          onLeave={leave}
          onCancel={dismiss}
        />
      )}
    </div>
  );
}
