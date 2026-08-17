import { describe, expect, it } from "vitest";
import {
  CELL_HEIGHT,
  CELL_WIDTH,
  createCellAllocator,
  findTakenCell,
  readStoredPosition,
  toCell,
  toPixels,
} from "./grid";

const at = (id: string, col: number, row: number) => ({ id, position: toPixels({ col, row }) });

describe("cell/pixel conversion", () => {
  it("round-trips a cell through pixels", () => {
    expect(toCell(toPixels({ col: 3, row: 2 }))).toEqual({ col: 3, row: 2 });
  });

  it("resolves a pixel anywhere inside a cell to that cell", () => {
    expect(toCell({ x: CELL_WIDTH * 2 + 40, y: CELL_HEIGHT * 1 - 30 })).toEqual({ col: 2, row: 1 });
  });
});

describe("readStoredPosition", () => {
  it("reads a lattice position as-is", () => {
    expect(readStoredPosition({ col: 1, row: 4 })).toEqual({ col: 1, row: 4 });
  });

  it("converts a pre-lattice pixel position", () => {
    expect(readStoredPosition({ x: CELL_WIDTH, y: CELL_HEIGHT * 3 })).toEqual({ col: 1, row: 3 });
  });

  it("has no answer for an unplaced node", () => {
    expect(readStoredPosition(undefined)).toBeUndefined();
  });
});

describe("findTakenCell", () => {
  it("reports the cell a drop would collide with", () => {
    const moving = [at("a", 1, 1)];
    expect(findTakenCell(moving, [...moving, at("b", 1, 1)])).toEqual({ col: 1, row: 1 });
  });

  it("ignores the cells the moving nodes themselves hold", () => {
    const moving = [at("a", 0, 0), at("b", 1, 0)];
    expect(findTakenCell(moving, [...moving, at("c", 2, 0)])).toBeUndefined();
  });
});

describe("createCellAllocator", () => {
  it("skips cells that are already taken", () => {
    const allocate = createCellAllocator([
      { col: 0, row: 0 },
      { col: 1, row: 0 },
    ]);
    expect(allocate()).toEqual({ col: 2, row: 0 });
  });

  it("never hands out the same cell twice", () => {
    const allocate = createCellAllocator([]);
    const cells = Array.from({ length: 9 }, allocate);
    expect(new Set(cells.map((cell) => `${cell.col},${cell.row}`)).size).toBe(9);
  });

  it("wraps to the next row after filling one", () => {
    const allocate = createCellAllocator([]);
    const cells = Array.from({ length: 5 }, allocate);
    expect(cells[4]).toEqual({ col: 0, row: 1 });
  });
});
