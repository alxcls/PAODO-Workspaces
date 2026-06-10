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
