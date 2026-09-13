"use client";

import { useEffect, useMemo, useSyncExternalStore } from "react";
import { FileTreeResource } from "../fileTreeResource";

/** Keep the cache scoped to one workspace/drive and dispose its requests when the view changes. */
export function useFileTree(base: string, refreshKey?: number) {
  const resource = useMemo(() => new FileTreeResource(base), [base]);
  const snapshot = useSyncExternalStore(resource.subscribe, resource.getSnapshot, resource.getSnapshot);

  useEffect(() => resource.cancel, [resource]);
  useEffect(() => {
    void resource.refresh();
  }, [resource, refreshKey]);

  return { ...snapshot, refreshTree: resource.refresh, loadChildren: resource.loadChildren };
}
