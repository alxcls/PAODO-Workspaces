"use client";
import { useState, useEffect, useCallback, useRef } from "react";

export type FileType = "text" | "image" | "binary" | null;

interface Options {
  onClose: () => void;
  onSelfWrite?: (path: string) => void;
}

export function useFileContent(
  workspaceId: string,
  filePath: string | null,
  { onClose, onSelfWrite }: Options
) {
  const [fileType, setFileType] = useState<FileType>(null);
  const [content, setContent] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [previewKey, setPreviewKey] = useState(0);

  // Refs stay current across renders without invalidating callbacks.
  const filePathRef = useRef(filePath);
  const isDirtyRef = useRef(false);
  const onCloseRef = useRef(onClose);
  const onSelfWriteRef = useRef(onSelfWrite);
  const draftRef = useRef(draft);

  filePathRef.current = filePath;
  onCloseRef.current = onClose;
  onSelfWriteRef.current = onSelfWrite;
  draftRef.current = draft;

  const isDirty = fileType === "text" && draft !== content;
  isDirtyRef.current = isDirty;

  const fetchContent = useCallback(async (path: string, silent = false) => {
    if (!silent) { setLoading(true); setFileType(null); setContent(null); setDraft(""); }
    setError(null);
    try {
      const res = await fetch(`/api/workspaces/${workspaceId}/files/content?path=${encodeURIComponent(path)}`);
      if (res.status === 404) { onCloseRef.current(); return; }
      if (!res.ok) { if (!silent) setError("Cannot load file"); return; }
      const data = (await res.json()) as { type: "text" | "image" | "binary"; content?: string };
      setFileType(data.type);
      setContent(data.content ?? null);
      setDraft(data.content ?? "");
    } catch {
      if (!silent) setError("Failed to fetch file");
    } finally {
      if (!silent) setLoading(false);
    }
  }, [workspaceId]);

  useEffect(() => {
    if (filePath) fetchContent(filePath);
    else { setFileType(null); setContent(null); setDraft(""); }
  }, [filePath, fetchContent]);

  const handleSave = useCallback(async () => {
    const path = filePathRef.current;
    if (!path) return;
    const currentDraft = draftRef.current;
    setSaving(true); setError(null);
    try {
      const res = await fetch(`/api/workspaces/${workspaceId}/files/content`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path, content: currentDraft }),
      });
      if (!res.ok) { setError("Save failed"); return; }
      setContent(currentDraft);
      onSelfWriteRef.current?.(path);
    } catch { setError("Save failed"); }
    finally { setSaving(false); }
  }, [workspaceId]);

  const deleteFile = useCallback(async () => {
    const path = filePathRef.current;
    if (!path) return;
    setDeleting(true);
    try {
      const res = await fetch(
        `/api/workspaces/${workspaceId}/files/content?path=${encodeURIComponent(path)}`,
        { method: "DELETE" }
      );
      if (!res.ok) {
        const body = await res.json().catch(() => ({} as { error?: string; message?: string }));
        setError(`Delete failed: ${body.error || body.message || `${res.status} ${res.statusText}`}`);
      } else {
        onCloseRef.current();
      }
    } catch { setError("Delete failed"); }
    finally { setDeleting(false); }
  }, [workspaceId]);

  const notifyFilesChanged = useCallback((paths: string[]) => {
    if (isDirtyRef.current) return;
    const currentPath = filePathRef.current ?? "";
    const isHtmlFile = /\.(html?|htm)$/i.test(currentPath);
    const directMatch = paths.includes(currentPath);
    const siblingChanged = isHtmlFile && paths.some(
      (p) => p !== currentPath && /\.(js|mjs|css|html?|htm|svg|png|jpg|jpeg|gif|webp|woff2?)$/i.test(p)
    );
    if (directMatch) {
      fetchContent(currentPath, true);
      if (isHtmlFile || /\.json$/i.test(currentPath)) setPreviewKey((k) => k + 1);
    } else if (siblingChanged) {
      setPreviewKey((k) => k + 1);
    }
  }, [fetchContent]);

  const notifyFilesDeleted = useCallback((paths: string[]) => {
    if (paths.includes(filePathRef.current ?? "")) onCloseRef.current();
  }, []);

  return {
    fileType, content, draft, setDraft,
    loading, error, saving, deleting,
    isDirty, previewKey,
    handleSave, deleteFile,
    notifyFilesChanged, notifyFilesDeleted,
  };
}
