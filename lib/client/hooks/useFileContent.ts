// Loads and manages the content of the single file open in the viewer. Fetches type + content
// from the files/content route, tracks an editable draft with a dirty flag, and exposes save and
// delete actions. notifyFilesChanged/notifyFilesDeleted let the parent (driven by the workspace
// socket) react to agent-side file changes: silently reloading the open file unless the user has
// unsaved edits, bumping previewKey to refresh the HTML preview (including sibling assets), and
// closing the viewer when the open file is deleted.
"use client";

import { useState, useEffect, useCallback, useRef } from "react";

export type FileType = "text" | "image" | "binary" | null;

/**
 * Decide how the viewer should react to a batch of changed paths. Pure so it can be unit-tested.
 *
 * Two independent signals drive an HTML preview reload, because a page has two kinds of dependency
 * that surface differently:
 *  - Tag-loaded subresources (`<script>`, `<link>`, `<img>`) are fetched by the browser itself, so
 *    the runtime fetch tracker never sees them. Their loadable types form a small, stable set, so we
 *    match them by extension — not brittle for this closed set.
 *  - Runtime data (`fetch()` to arbitrary paths/extensions, e.g. an index.html reading a JSON in a
 *    subfolder) can't be guessed statically, so we reload only when a file the preview *actually
 *    fetched* changes. `observedDeps` is that runtime-observed set (see HtmlLivePreview).
 * Anything not matched by either signal is treated as unrelated and does NOT reload the preview, so
 * an edit to some other file (a Python script, say) never flickers the preview.
 */
export function decidePreviewReaction(
  currentPath: string,
  changedPaths: string[],
  observedDeps: ReadonlySet<string>
): { reloadContent: boolean; reloadPreview: boolean } {
  const isHtmlFile = /\.(html?|htm)$/i.test(currentPath);
  const directMatch = changedPaths.includes(currentPath);
  const siblingChanged = isHtmlFile && changedPaths.some(
    (p) => p !== currentPath && /\.(js|mjs|css|html?|htm|svg|png|jpg|jpeg|gif|webp|woff2?)$/i.test(p)
  );
  const depChanged = isHtmlFile && changedPaths.some(
    (p) => p !== currentPath && observedDeps.has(p)
  );
  return {
    reloadContent: directMatch,
    reloadPreview: (directMatch && isHtmlFile) || siblingChanged || depChanged,
  };
}

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
  const [previewKey, setPreviewKey] = useState(0);

  // Resources the live HTML preview actually fetched at runtime, reported by HtmlLivePreview. A
  // change to one of these reloads the preview even though we can't infer the dependency statically.
  const observedDepsRef = useRef<Set<string>>(new Set());

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

  // A fresh page load — a different file, or a preview reload (previewKey bump) — re-fetches its
  // resources from scratch, so drop the observed set and let the reloaded iframe repopulate it.
  useEffect(() => {
    observedDepsRef.current = new Set();
  }, [filePath, previewKey]);

  // Called by HtmlLivePreview each time the previewed page fetches a workspace file.
  const registerPreviewDependency = useCallback((path: string) => {
    observedDepsRef.current.add(path);
  }, []);

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

  const notifyFilesChanged = useCallback((paths: string[]) => {
    if (isDirtyRef.current) return;
    const currentPath = filePathRef.current ?? "";
    const { reloadContent, reloadPreview } = decidePreviewReaction(currentPath, paths, observedDepsRef.current);
    if (reloadContent) fetchContent(currentPath, true);
    if (reloadPreview) setPreviewKey((k) => k + 1);
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
    registerPreviewDependency,
  };
}
