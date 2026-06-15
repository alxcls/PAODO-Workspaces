// Fetches a workspace's display metadata (currently just its name) from the workspace route
// when the id changes. Returns { name }, defaulting to an empty string until the fetch resolves;
// errors are swallowed so the UI simply shows no name rather than breaking.
"use client";

import { useState, useEffect } from "react";

export function useWorkspaceMeta(workspaceId: string) {
  const [name, setName] = useState("");

  useEffect(() => {
    fetch(`/api/workspaces/${workspaceId}`)
      .then((r) => r.json())
      .then((data: { name: string }) => setName(data.name))
      .catch(() => {});
  }, [workspaceId]);

  return { name };
}
