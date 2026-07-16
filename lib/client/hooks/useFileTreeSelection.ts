// Holds the set of selected file-tree paths. handleSelect adds or removes a batch of paths
// (so selecting a directory can toggle all its descendants at once), selectPaths adds a shift+click
// range, and clearSelection resets it. Kept separate from useFileOperations so selection state and
// the actions on it stay decoupled.

import { useState } from "react";
import { remapMovedPath } from "../fileMove";

export function useFileTreeSelection() {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  // The row a shift+click range measures from: the last one checked *without* shift. Every
  // successive shift+click re-measures from it rather than from the previous one, so a range can be
  // widened and narrowed by clicking around without re-anchoring.
  const [anchorPath, setAnchorPath] = useState<string | null>(null);

  const handleSelect = (paths: string[], on: boolean) => {
    // Callers pass the clicked node first, then any descendants it cascades to.
    setAnchorPath(paths[0] ?? null);
    setSelected((prev) => {
      const next = new Set(prev);
      for (const p of paths) { if (on) next.add(p); else next.delete(p); }
      return next;
    });
  };

  /** Adds a range on top of the current selection, deliberately leaving the anchor where it is. */
  const selectPaths = (paths: string[]) => {
    if (paths.length === 0) return;
    setSelected((prev) => {
      const next = new Set(prev);
      for (const p of paths) next.add(p);
      return next;
    });
  };

  const clearSelection = () => {
    setSelected(new Set());
    setAnchorPath(null);
  };

  const remapSelection = (sourceRoot: string, destinationRoot: string) => {
    setSelected((prev) => new Set(
      Array.from(prev, (path) => remapMovedPath(path, sourceRoot, destinationRoot) ?? path),
    ));
    setAnchorPath((current) => remapMovedPath(current, sourceRoot, destinationRoot));
  };

  return { selected, anchorPath, handleSelect, selectPaths, clearSelection, remapSelection };
}
