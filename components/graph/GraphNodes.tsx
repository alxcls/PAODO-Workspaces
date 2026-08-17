import { Handle, Position, type NodeProps } from "@xyflow/react";
import Image from "next/image";
import { WORKSPACE_BOTTOM_HANDLE, WORKSPACE_TOP_HANDLE } from "./handles";

// The two node types the canvas renders. Both are pure presentation — they read only from the
// `data` React Flow hands them, so what a node looks like changes here and nowhere else.

// Shared card body for graph nodes so workspace and drive nodes look identical
// (icon + name + optional description). Handles are passed as children and absolutely
// positioned by React Flow against the card edges; the node types differ only in those.
function NodeCard({
  icon,
  label,
  description,
  selected,
  title,
  className = "",
  children,
}: {
  icon: React.ReactNode;
  label: string;
  description?: string;
  selected?: boolean;
  title?: string;
  className?: string;
  children?: React.ReactNode;
}) {
  const hasDescription = Boolean(description?.trim());
  return (
    <div
      title={title}
      className={`bg-white border rounded-card p-[12px_14px_16px] w-[280px] shadow-sm transition-[border-color,box-shadow] duration-[140ms] hover:border-primary-2 ${selected ? "border-primary shadow-[0_0_0_2px_var(--color-primary-soft),var(--shadow-sm)]" : "border-border"} ${className}`}
    >
      {children}
      <div className="flex gap-3 items-center">
        <div className="flex h-[34px] w-[34px] flex-shrink-0 items-center justify-center">{icon}</div>
        <div className="min-w-0 flex-1">
          <div className="font-semibold text-ms text-text whitespace-nowrap overflow-hidden text-ellipsis">{label}</div>
          {hasDescription && (
            <div className="text-xs text-text-2 mt-1 leading-[1.4] whitespace-pre-wrap line-clamp-2">{description}</div>
          )}
        </div>
      </div>
    </div>
  );
}

export function WorkspaceNode({ data, selected }: NodeProps) {
  return (
    <NodeCard
      icon={
        <Image
          src="/agent-robot.svg"
          alt="Workspace icon"
          width={34}
          height={34}
          className="h-[34px] w-[34px]"
          unoptimized
        />
      }
      label={data.label as string}
      description={data.description as string}
      selected={selected}
      title="Open workspace"
      className="cursor-pointer"
    >
      <Handle
        id={WORKSPACE_TOP_HANDLE}
        type="target"
        position={Position.Top}
        className="graph-handle"
        isConnectableStart={false}
      />
      <Handle
        id={WORKSPACE_BOTTOM_HANDLE}
        type="source"
        position={Position.Bottom}
        className="graph-handle"
        isConnectableEnd
      />
    </NodeCard>
  );
}

const DriveIcon = () => (
  <svg viewBox="0 0 24 24" width="34" height="34" fill="none" aria-hidden="true" className="text-black">
    <path
      d="M3.19048 15L6.50933 6.28801C6.80476 5.5125 7.54842 5 8.3783 5H15.6217C16.4516 5 17.1952 5.5125 17.4907 6.28801L20.8095 15M18.0161 16.0161L18 16M6.375 19H17.625C19.489 19 21 17.6569 21 16C21 14.3431 19.489 13 17.625 13H6.375C4.51104 13 3 14.3431 3 16C3 17.6569 4.51104 19 6.375 19Z"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

// Drive node: same card as a workspace (icon + name + description), so the two node types are
// visually consistent. Top and bottom source handles let you start a drive->workspace link;
// the edges float (anchor to the nearest border), so two handles are enough.
export function DriveNode({ data, selected }: NodeProps) {
  return (
    <NodeCard
      icon={<DriveIcon />}
      label={data.label as string}
      description={data.description as string}
      selected={selected}
      title="Open drive"
      className="cursor-pointer"
    >
      <Handle id="drive-top" type="source" position={Position.Top} className="graph-handle" />
      <Handle id="drive-bottom" type="source" position={Position.Bottom} className="graph-handle" />
    </NodeCard>
  );
}
