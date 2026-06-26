import { Position, type InternalNode, type Node } from "@xyflow/react";

// Geometry helpers for "floating" edges: instead of anchoring to a fixed handle,
// an edge attaches to the point on each node's border that faces the other node,
// recomputed live as nodes move. Adapted from the React Flow floating-edges recipe.

// Point on `node`'s border where the line toward `target`'s center crosses it.
function getNodeIntersection(node: InternalNode<Node>, target: InternalNode<Node>) {
  const w = (node.measured.width ?? 0) / 2;
  const h = (node.measured.height ?? 0) / 2;
  const nodeCenterX = node.internals.positionAbsolute.x + w;
  const nodeCenterY = node.internals.positionAbsolute.y + h;
  const targetCenterX = target.internals.positionAbsolute.x + (target.measured.width ?? 0) / 2;
  const targetCenterY = target.internals.positionAbsolute.y + (target.measured.height ?? 0) / 2;

  const xx1 = (targetCenterX - nodeCenterX) / (2 * w) - (targetCenterY - nodeCenterY) / (2 * h);
  const yy1 = (targetCenterX - nodeCenterX) / (2 * w) + (targetCenterY - nodeCenterY) / (2 * h);
  const a = 1 / (Math.abs(xx1) + Math.abs(yy1) || 1);
  const xx3 = a * xx1;
  const yy3 = a * yy1;
  return {
    x: w * (xx3 + yy3) + nodeCenterX,
    y: h * (-xx3 + yy3) + nodeCenterY,
  };
}

// Which side of `node` the intersection point sits on (drives the curve's tangent).
function getEdgePosition(node: InternalNode<Node>, point: { x: number; y: number }): Position {
  const nx = Math.round(node.internals.positionAbsolute.x);
  const ny = Math.round(node.internals.positionAbsolute.y);
  const px = Math.round(point.x);
  const py = Math.round(point.y);
  if (px <= nx + 1) return Position.Left;
  if (px >= nx + (node.measured.width ?? 0) - 1) return Position.Right;
  if (py <= ny + 1) return Position.Top;
  return Position.Bottom;
}

export function getEdgeParams(source: InternalNode<Node>, target: InternalNode<Node>) {
  const sourcePoint = getNodeIntersection(source, target);
  const targetPoint = getNodeIntersection(target, source);
  return {
    sx: sourcePoint.x,
    sy: sourcePoint.y,
    tx: targetPoint.x,
    ty: targetPoint.y,
    sourcePos: getEdgePosition(source, sourcePoint),
    targetPos: getEdgePosition(target, targetPoint),
  };
}
