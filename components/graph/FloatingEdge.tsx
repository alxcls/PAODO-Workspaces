import {
  BaseEdge,
  getBezierPath,
  useInternalNode,
  type EdgeProps,
  type ConnectionLineComponentProps,
} from "@xyflow/react";
import { getEdgeParams } from "./floatingEdgeUtils";

// Edge that anchors to the nearest border point of each node rather than to a fixed
// handle, so links stay visually attached as nodes are dragged around. Rendered via
// BaseEdge so it gets the transparent wide interaction path — without it the thin dashed
// line is nearly impossible to click, so the edge can't be selected and therefore can't
// be deleted with the Delete/Backspace key.
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

// Drag preview while a connection is being drawn. For drives it floats from the node's
// nearest border (matching committed drive edges); for workspaces it starts at the handle
// being dragged, so the input/output side stays meaningful.
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
