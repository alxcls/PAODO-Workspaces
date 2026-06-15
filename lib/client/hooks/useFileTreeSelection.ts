// Holds the set of selected file-tree paths. handleSelect adds or removes a batch of paths
// (so selecting a directory can toggle all its descendants at once), and clearSelection resets
// it. Kept separate from useFileOperations so selection state and the actions on it stay decoupled.

import { useState } from "react";

export function useFileTreeSelection() {
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const handleSelect = (paths: string[], on: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev);
      for (const p of paths) { if (on) next.add(p); else next.delete(p); }
      return next;
    });
  };

  const clearSelection = () => setSelected(new Set());

  return { selected, handleSelect, clearSelection };
}
