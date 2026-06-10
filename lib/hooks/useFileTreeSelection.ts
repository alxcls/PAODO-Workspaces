import { useState } from "react";

export function useFileTreeSelection() {
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const handleSelect = (paths: string[], on: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev);
      for (const p of paths) on ? next.add(p) : next.delete(p);
      return next;
    });
  };

  const clearSelection = () => setSelected(new Set());

  return { selected, handleSelect, clearSelection };
}
