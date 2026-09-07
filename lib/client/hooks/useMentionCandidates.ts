// Flat file/folder list for the composer's @mention popup, refreshed from the server each time the
// menu opens (so new files appear), ordered directories-first. Concurrent refreshes are de-duped.

import { useCallback, useRef, useState } from "react";
import { flattenTree } from "../fileTreeOrder";
import type { TreeNode } from "./useFileOperations";

export function useMentionCandidates(workspaceId: string) {
  const [candidates, setCandidates] = useState<TreeNode[]>([]);
  const inFlightRef = useRef(false);

  const refresh = useCallback(async () => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    try {
      const res = await fetch(`/api/workspaces/${workspaceId}/files?depth=full`);
      if (!res.ok) return;
      const { tree } = (await res.json()) as { tree: TreeNode[] };
      setCandidates(flattenTree(tree));
    } catch {
      /* silent — popup just shows the last-known list */
    } finally {
      inFlightRef.current = false;
    }
  }, [workspaceId]);

  return { candidates, refresh };
}
