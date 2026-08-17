import {
  BaseEdge,
  getBezierPath,
  useInternalNode,
  type EdgeProps,
  type ConnectionLineComponentProps,
} from "@xyflow/react";
import { getEdgeParams } from "./floatingEdgeUtils";

// Anchors to each node's nearest border point rather than a fixed handle, so links stay attached
// while dragging. BaseEdge adds the wide invisible hit path — without it the line can't be clicked.
export function FloatingEdge({ id, source, target, markerEnd, style }: EdgeProps) {
  const sourceNode = useInternalNode(source);
  const targetNode = useInternalNode(target);
  if (!sourceNode || !targetNode) return null;

  const { sx, sy, tx, ty, sourcePos, targetPos } = getEdgeParams(sourceNode, targetNode);
  const [path] = getBezierPath({
    sourceX: sx,
    sourceY: sy,
    sourcePosition: sourcePos,
    targetX: tx,
    targetY: ty,
    targetPosition: targetPos,
  });

  return <BaseEdge id={id} path={path} markerEnd={markerEnd} style={style} interactionWidth={20} />;
}

// Drag preview while drawing a connection: drives float from the nearest border (matching a
// committed drive edge), workspaces start at the dragged handle so input/output stays meaningful.
export function FloatingConnectionLine({
  fromX,
  fromY,
  toX,
  toY,
  fromNode,
  fromPosition,
}: ConnectionLineComponentProps) {
  if (!fromNode) return null;

  const isDrive = fromNode.type === "drive";
  let sx = fromX;
  let sy = fromY;
  let sourcePos = fromPosition;
  if (isDrive) {
    const params = getEdgeParams(fromNode, {
      internals: { positionAbsolute: { x: toX, y: toY } },
      measured: { width: 1, height: 1 },
    } as never);
    sx = params.sx;
    sy = params.sy;
    sourcePos = params.sourcePos;
  }
  const [path] = getBezierPath({
    sourceX: sx,
    sourceY: sy,
    sourcePosition: sourcePos,
    targetX: toX,
    targetY: toY,
  });

  return (
    <g>
      <path className="react-flow__connection-path" d={path} />
      <circle cx={toX} cy={toY} r={3} stroke="var(--color-primary)" strokeWidth={1.5} fill="#fff" />
    </g>
  );
}
