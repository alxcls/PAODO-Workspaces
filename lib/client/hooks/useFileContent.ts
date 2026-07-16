// Loads and manages the content of the single file open in the viewer. Fetches type + content
// from the files/content route, tracks an editable draft with a dirty flag, and exposes save and
// delete actions. File changes reload only the open, clean file; deletions close the viewer.
"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { EditorFileMutationLock, remapMovedPath } from "../fileMove";

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
  const [moving, setMoving] = useState(false);

  // Refs stay current across renders without invalidating callbacks.
  const filePathRef = useRef(filePath);
  const isDirtyRef = useRef(false);
  const onCloseRef = useRef(onClose);
  const onSelfWriteRef = useRef(onSelfWrite);
  const draftRef = useRef(draft);
  const mutationLockRef = useRef(new EditorFileMutationLock());
  const preservedMovedPathRef = useRef<string | null>(null);

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
    if (filePath && preservedMovedPathRef.current === filePath) {
      // A rename does not change the file's contents. Keep the current editor state — especially a
      // dirty draft — instead of clearing it and reloading the last saved content from disk.
      preservedMovedPathRef.current = null;
    } else if (filePath) fetchContent(filePath);
    else { setFileType(null); setContent(null); setDraft(""); }
  }, [filePath, fetchContent]);

  const handleSave = useCallback(async () => {
    const path = filePathRef.current;
    if (!path || !mutationLockRef.current.startMutation(path)) return;
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
    finally {
      mutationLockRef.current.finishMutation();
      setSaving(false);
    }
  }, [base]);

  const deleteFile = useCallback(async () => {
    const path = filePathRef.current;
    if (!path || !mutationLockRef.current.startMutation(path)) return;
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
    finally {
      mutationLockRef.current.finishMutation();
      setDeleting(false);
    }
  }, [base]);

  // Reload the open file after an agent-side edit, but never overwrite a local draft.
  const notifyFilesChanged = useCallback((paths: string[]) => {
    if (isDirtyRef.current) return;
    const currentPath = filePathRef.current ?? "";
    if (paths.includes(currentPath)) fetchContent(currentPath, true);
  }, [fetchContent]);

  const notifyFilesDeleted = useCallback((paths: string[]) => {
    const currentPath = filePathRef.current ?? "";
    // A local move is observed by chokidar as a source deletion plus a destination addition. The
    // deletion can arrive before the PATCH response, so do not close the viewer while that move is
    // pending; completion remaps the path, while cancellation clears this exception.
    if (mutationLockRef.current.pendingMoveRoot && paths.includes(currentPath)) return;
    if (paths.includes(currentPath)) onCloseRef.current();
  }, []);

  const notifyFileMoveStarted = useCallback((sourceRoot: string): boolean => {
    const currentPath = filePathRef.current;
    const allowed = mutationLockRef.current.startMove(sourceRoot, currentPath);
    if (!allowed) return false;
    if (mutationLockRef.current.pendingMoveRoot === sourceRoot) setMoving(true);
    return true;
  }, []);

  const notifyFileMoveCancelled = useCallback((sourceRoot: string) => {
    mutationLockRef.current.finishMove(sourceRoot);
    setMoving(false);
  }, []);

  const notifyFileMoved = useCallback((sourceRoot: string, destinationRoot: string) => {
    if (mutationLockRef.current.pendingMoveRoot !== sourceRoot) return;
    mutationLockRef.current.finishMove(sourceRoot);
    setMoving(false);
    const currentPath = filePathRef.current;
    const movedPath = remapMovedPath(currentPath, sourceRoot, destinationRoot);
    if (movedPath === null || movedPath === currentPath) return;
    // Update the imperative callbacks immediately, before React commits the parent path update.
    filePathRef.current = movedPath;
    preservedMovedPathRef.current = movedPath;
  }, []);

  return {
    fileType, content, draft, setDraft,
    loading, error, saving, deleting, moving,
    isDirty,
    handleSave, deleteFile,
    notifyFilesChanged, notifyFilesDeleted,
    notifyFileMoveStarted, notifyFileMoveCancelled, notifyFileMoved,
  };
}
