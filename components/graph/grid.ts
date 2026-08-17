// The canvas is a lattice: a node occupies one cell addressed by integer col/row, so two cards share
// a cell or nothing. React Flow is pixels-only; this module is the single boundary between the two.
import type { CellPosition, NodePosition } from "@/lib/agent/graph";

/** Wide enough for the fixed-width card plus a gutter, tall enough to read an edge between rows. */
export const CELL_WIDTH = 320;
export const CELL_HEIGHT = 200;

/** React Flow's `snapGrid`. A node's top-left snaps to a cell corner, which is what turns a cell
 *  from a drawing on the background into an actual slot. */
export const SNAP_GRID: [number, number] = [CELL_WIDTH, CELL_HEIGHT];

/** Cells per row before the allocator wraps to the next one. */
const GRID_COLUMNS = 4;

export interface PixelPosition {
  x: number;
  y: number;
}

export function toPixels({ col, row }: CellPosition): PixelPosition {
  return { x: col * CELL_WIDTH, y: row * CELL_HEIGHT };
}

export function toCell({ x, y }: PixelPosition): CellPosition {
  return { col: Math.round(x / CELL_WIDTH), row: Math.round(y / CELL_HEIGHT) };
}

/** Read a stored position as a cell, accepting the pre-lattice pixel shape. */
export function readStoredPosition(stored: NodePosition | undefined): CellPosition | undefined {
  if (!stored) return undefined;
  return "col" in stored ? { col: stored.col, row: stored.row } : toCell(stored);
}

const cellKey = ({ col, row }: CellPosition) => `${col},${row}`;

/** The one answer to "is this spot taken". On a lattice that is a set lookup rather than an
 *  intersection test against every other card, which is what makes the scans below cheap. */
function occupancy(cells: Iterable<CellPosition>) {
  const taken = new Set([...cells].map(cellKey));
  return {
    has: (cell: CellPosition) => taken.has(cellKey(cell)),
    add: (cell: CellPosition) => taken.add(cellKey(cell)),
  };
}

interface PlacedNode {
  id: string;
  position: PixelPosition;
}

/** The first cell a moving node would land on that some other node already holds, if any. Moving
 *  nodes are excluded, so a drop back where the drag started never reads as a collision and a
 *  multi-node drag never collides with itself. */
export function findTakenCell(moving: PlacedNode[], all: PlacedNode[]): CellPosition | undefined {
  const movingIds = new Set(moving.map((node) => node.id));
  const taken = occupancy(all.filter((node) => !movingIds.has(node.id)).map((node) => toCell(node.position)));
  return moving.map((node) => toCell(node.position)).find((cell) => taken.has(cell));
}

/** Hands out cells to nodes nobody has placed yet, skipping every cell already taken, so a workspace
 *  or drive arriving from outside the editor lands somewhere empty instead of on a placed node. */
export function createCellAllocator(taken: Iterable<CellPosition>) {
  const occupied = occupancy(taken);
  let next = 0;
  return (): CellPosition => {
    for (;;) {
      const cell = { col: next % GRID_COLUMNS, row: Math.floor(next / GRID_COLUMNS) };
      next += 1;
      if (occupied.has(cell)) continue;
      occupied.add(cell);
      return cell;
    }
  };
}
