// The canvas is a lattice. A node occupies one cell addressed by integer col/row, and a cell is the
// only placement a card can take — so two cards can never half-overlap, only share a cell or not.
//
// React Flow is pixels-only, so col/row is the stored and transported shape and this module is the
// single boundary between the two systems. Everything above it reasons in cells; only ReactFlow
// itself sees pixels. Keeping the conversion here is what lets a node be placed without measuring
// anything: a cell's size is a constant, not a rendered card's height.
import type { CellPosition, NodePosition } from "@/lib/agent/graph";

/** Wide enough for the fixed-width card plus a gutter, tall enough to read an edge between rows. */
export const CELL_WIDTH = 320;
export const CELL_HEIGHT = 200;

/** React Flow's `snapGrid`. A node's top-left snaps to a cell corner, which is what turns a cell
 *  from a drawing on the background into an actual slot. */
export const SNAP_GRID: [number, number] = [CELL_WIDTH, CELL_HEIGHT];

/** Cells per row before the allocator wraps to the next one. */
const GRID_COLUMNS = 4;

export function toPixels({ col, row }: CellPosition) {
  return { x: col * CELL_WIDTH, y: row * CELL_HEIGHT };
}

export function toCell({ x, y }: { x: number; y: number }): CellPosition {
  return { col: Math.round(x / CELL_WIDTH), row: Math.round(y / CELL_HEIGHT) };
}

/** Read a stored position as a cell, accepting the pre-lattice pixel shape. */
export function readStoredPosition(stored: NodePosition | undefined): CellPosition | undefined {
  if (!stored) return undefined;
  return "col" in stored ? { col: stored.col, row: stored.row } : toCell(stored);
}

const cellKey = ({ col, row }: CellPosition) => `${col},${row}`;

interface PlacedNode {
  id: string;
  position: { x: number; y: number };
}

/**
 * The first cell a moving node would land on that some other node already holds, if any.
 *
 * The nodes being moved are excluded from the occupancy set, so dropping a card back where it
 * started never reads as a collision, and a multi-node drag never collides with itself.
 */
export function findTakenCell(moving: PlacedNode[], all: PlacedNode[]): CellPosition | undefined {
  const movingIds = new Set(moving.map((node) => node.id));
  const taken = new Set<string>();
  for (const node of all) {
    if (!movingIds.has(node.id)) taken.add(cellKey(toCell(node.position)));
  }
  return moving.map((node) => toCell(node.position)).find((cell) => taken.has(cellKey(cell)));
}

/**
 * Hands out cells to nodes nobody has placed yet, skipping every cell already taken.
 *
 * This is the payoff of the lattice. Asking "is this spot free" used to mean intersecting a
 * variable-width, variable-height card against every other card; on a lattice it is one set lookup,
 * so first-free-cell is a scan short enough to not think about. A workspace or drive that appears
 * from outside the editor therefore lands somewhere empty instead of on top of a placed node.
 */
export function createCellAllocator(taken: Iterable<CellPosition>) {
  const occupied = new Set([...taken].map(cellKey));
  let next = 0;
  return (): CellPosition => {
    for (;;) {
      const cell = { col: next % GRID_COLUMNS, row: Math.floor(next / GRID_COLUMNS) };
      next += 1;
      if (occupied.has(cellKey(cell))) continue;
      occupied.add(cellKey(cell));
      return cell;
    }
  };
}
