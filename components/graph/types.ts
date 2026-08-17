// The vocabulary every graph module shares: what a node carries, and how to tell the two kinds
// apart. Kept as predicates so a third node kind is one file to change, not nine call sites.
import type { Edge, Node } from "@xyflow/react";

export const DRIVE_KIND = "drive";

export interface GraphNodeData {
  label: string;
  description?: string;
  kind?: typeof DRIVE_KIND;
}

/** Read a React Flow node's untyped `data` bag as the shape this editor always writes. */
export const nodeData = (data: Node["data"]) => data as unknown as GraphNodeData;

export const isDriveNode = (node: Node) => nodeData(node.data)?.kind === DRIVE_KIND;

export const isDriveEdge = (edge: Edge) => edge.data?.kind === DRIVE_KIND;

/** One wording for the destructive half of a save, shown both in the modal and the confirm(). */
export function driveDeleteWarning(drives: Node[]): string {
  const names = drives.map((drive) => nodeData(drive.data).label).join(", ");
  return `Saving permanently deletes ${names} and everything stored in ${drives.length > 1 ? "them" : "it"}.`;
}
