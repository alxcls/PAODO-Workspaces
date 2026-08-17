// How the two edge kinds are drawn. Shared by the loader (rebuilding saved edges) and the
// connection rules (drawing a new one), so a restyle never leaves the two disagreeing.
import { MarkerType } from "@xyflow/react";
import { DRIVE_KIND } from "./types";

export const EDGE_STYLE = {
  type: "floating" as const,
  style: { stroke: "var(--color-text-3)", strokeWidth: 1.5 },
  markerEnd: { type: MarkerType.ArrowClosed, color: "var(--color-primary)" },
};

export const DRIVE_EDGE_STYLE = {
  type: "floating" as const,
  style: { stroke: "var(--color-text-3)", strokeWidth: 1.5, strokeDasharray: "5 4" },
  data: { kind: DRIVE_KIND as typeof DRIVE_KIND },
};
