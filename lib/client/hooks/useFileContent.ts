// Loads and manages the content of the single file open in the viewer. Fetches type + content
// from the files/content route, tracks an editable draft with a dirty flag, and exposes save and
// delete actions. notifyFilesChanged silently reloads the open file when it changes on disk (so the
// code editor and Markdown preview reflect agent-side edits live), and notifyFilesDeleted closes
// the viewer when the open file is deleted. HTML previews are the one exception: their iframe is
// NOT auto-reloaded on file-system changes (the dependency-tracking auto-refresh proved unreliable
// and flickery — see git), so an open .html refreshes only when the user reopens it.
"use client";

import { useState, useEffect, useCallback, useRef } from "react";

export type FileType = "text" | "image" | "binary" | null;

interface Options {
  onClose: () => void;
  onSelfWrite?: (path: string) => void;
  /** API base for file routes. Defaults to the workspace path; drives pass /api/drives/<id>. */
  apiBase?: string;
}

export function useFileContent(
  workspaceId: string,
  filePath: string | null,
  { onClose, onSelfWrite, apiBase }: Options
) {
  const base = apiBase ?? `/api/workspaces/${workspaceId}`;
  const [fileType, setFileType] = useState<FileType>(null);
  const [content, setContent] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);

  // Refs stay current across renders without invalidating callbacks.
  const filePathRef = useRef(filePath);
  const isDirtyRef = useRef(false);
  const onCloseRef = useRef(onClose);
  const onSelfWriteRef = useRef(onSelfWrite);
  const draftRef = useRef(draft);

  const isDirty = fileType === "text" && draft !== content;

  // Mirror the latest props/derived values into refs in an effect (not during render) so they
  // only ever track committed renders. All of these are read solely inside the async callbacks
  // below, so effect-timing updates are always current by the time a read happens.
  useEffect(() => {
    filePathRef.current = filePath;
    onCloseRef.current = onClose;
    onSelfWriteRef.current = onSelfWrite;
    draftRef.current = draft;
    isDirtyRef.current = isDirty;
  });

  const fetchContent = useCallback(async (path: string, silent = false) => {
    if (!silent) { setLoading(true); setFileType(null); setContent(null); setDraft(""); }
    setError(null);
    try {
      const res = await fetch(`${base}/files/content?path=${encodeURIComponent(path)}`);
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
  }, [base]);

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
      const res = await fetch(`${base}/files/content`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path, content: currentDraft }),
      });
      if (!res.ok) { setError("Save failed"); return; }
      setContent(currentDraft);
      onSelfWriteRef.current?.(path);
    } catch { setError("Save failed"); }
    finally { setSaving(false); }
  }, [base]);

  const deleteFile = useCallback(async () => {
    const path = filePathRef.current;
    if (!path) return;
    setDeleting(true);
    try {
      const res = await fetch(
        `${base}/files/content?path=${encodeURIComponent(path)}`,
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
  }, [base]);

  // The open file changed on disk (e.g. the agent edited it). Silently reload its content so the
  // code editor and Markdown preview stay live — unless the user has unsaved edits. HTML files are
  // skipped on purpose: reloading their content would reload the live-preview iframe, which is the
  // flickery auto-refresh we removed. Open .html previews refresh only on manual reopen instead.
  const notifyFilesChanged = useCallback((paths: string[]) => {
    if (isDirtyRef.current) return;
    const currentPath = filePathRef.current ?? "";
    if (!paths.includes(currentPath)) return;
    if (/\.(html?|htm)$/i.test(currentPath)) return;
    fetchContent(currentPath, true);
  }, [fetchContent]);

  const notifyFilesDeleted = useCallback((paths: string[]) => {
    if (paths.includes(filePathRef.current ?? "")) onCloseRef.current();
  }, []);

  return {
    fileType, content, draft, setDraft,
    loading, error, saving, deleting,
    isDirty,
    handleSave, deleteFile,
    notifyFilesChanged, notifyFilesDeleted,
  };
}
