// Centre pane that loads and displays workspace files with syntax highlighting and inline editing.
// File-change and file-delete notifications arrive via the imperative handle (notifyFilesChanged /
// notifyFilesDeleted), called by the workspace page which owns the shared WebSocket connection.
// Self-write suppression is signalled back to the page via the onSelfWrite prop after a save.
"use client";

import { useState, useEffect, useCallback, useRef, useMemo, forwardRef, useImperativeHandle } from "react";
import dynamic from "next/dynamic";
import hljs from "@/lib/highlighter";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import "jsoncrack-react/style.css";

const JSONCrack = dynamic(() => import("jsoncrack-react").then(m => m.JSONCrack), { ssr: false });

function detectLang(filePath: string): string {
  const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
  const map: Record<string, string> = {
    ts: "typescript", tsx: "typescript",
    js: "javascript", jsx: "javascript",
    py: "python", rb: "ruby", rs: "rust",
    cs: "csharp", kt: "kotlin", kts: "kotlin",
    sh: "bash", zsh: "bash",
    html: "xml", htm: "xml", svg: "xml",
    yml: "yaml", tf: "hcl", toml: "ini",
    gql: "graphql", proto: "protobuf", ps1: "powershell",
    md: "markdown", json: "json", txt: "txt",
  };
  return map[ext] ?? "";
}

const CloseIcon = () => (
  <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
    <path d="M4 4l8 8M12 4l-8 8" />
  </svg>
);

export interface FileViewerHandle {
  notifyFilesChanged: (paths: string[]) => void;
  notifyFilesDeleted: (paths: string[]) => void;
}

interface Props {
  workspaceId: string; filePath: string | null;
  onClose: () => void; onSelfWrite?: (path: string) => void;
}

const FileViewer = forwardRef<FileViewerHandle, Props>(function FileViewer(
  { workspaceId, filePath, onClose, onSelfWrite },
  ref
) {
  const [fileType, setFileType] = useState<"text" | "image" | "binary" | null>(null);
  const [content, setContent] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [showPreview, setShowPreview] = useState(false);
  const [previewKey, setPreviewKey] = useState(0);
  const preRef = useRef<HTMLPreElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const gutterRef = useRef<HTMLDivElement>(null);

  const filePathRef = useRef<string | null>(filePath);
  const isDirtyRef = useRef(false);
  const onCloseRef = useRef(onClose);

  // Assign during render so the refs are always current before any effect or imperative call runs.
  filePathRef.current = filePath;
  onCloseRef.current = onClose;

  const lang = filePath ? detectLang(filePath) : "txt";
  const isHtml = /\.(html?|htm)$/i.test(filePath ?? "");

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
    setShowPreview(lang === "markdown" || isHtml || lang === "json");
  }, [filePath, fetchContent, lang]);

  useImperativeHandle(ref, () => ({
    notifyFilesChanged(paths: string[]) {
      if (isDirtyRef.current) return;
      const currentPath = filePathRef.current ?? "";
      const directMatch = paths.includes(currentPath);
      const isHtmlFile = /\.(html?|htm)$/i.test(currentPath);
      const siblingChanged = isHtmlFile && paths.some(p => p !== currentPath && /\.(js|mjs|css|html?|htm|svg|png|jpg|jpeg|gif|webp|woff2?)$/i.test(p));
      if (directMatch) {
        fetchContent(currentPath, true);
        if (isHtmlFile || /\.json$/i.test(currentPath)) setPreviewKey(k => k + 1);
      } else if (siblingChanged) {
        setPreviewKey(k => k + 1);
      }
    },
    notifyFilesDeleted(paths: string[]) {
      if (paths.includes(filePathRef.current ?? "")) onCloseRef.current();
    },
  }), [fetchContent]);

  function syncScroll() {
    if (preRef.current && taRef.current) {
      preRef.current.scrollTop = taRef.current.scrollTop;
      preRef.current.scrollLeft = taRef.current.scrollLeft;
    }
    if (gutterRef.current && taRef.current) {
      gutterRef.current.scrollTop = taRef.current.scrollTop;
    }
  }

  async function handleDelete() {
    if (!filePath || !confirm(`Delete ${filePath.split("/").pop()}?`)) return;
    setDeleting(true);
    try {
      const res = await fetch(`/api/workspaces/${workspaceId}/files/content?path=${encodeURIComponent(filePath)}`, { method: "DELETE" });
      if (!res.ok) {
        const body = await res.json().catch(() => ({} as any));
        const msg = (body && (body.error || body.message)) || `${res.status} ${res.statusText}`;
        setError(`Delete failed: ${msg}`);
      } else {
        onClose();
      }
    } catch { setError("Delete failed"); }
    finally { setDeleting(false); }
  }

  async function handleSave() {
    if (!filePath) return;
    setSaving(true); setError(null);
    try {
      const res = await fetch(`/api/workspaces/${workspaceId}/files/content`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: filePath, content: draft }),
      });
      if (!res.ok) { setError("Save failed"); return; }
      setContent(draft);
      onSelfWrite?.(filePath);
    } catch { setError("Save failed"); }
    finally { setSaving(false); }
  }

  const htmlForPreview = useMemo(() => {
    if (!isHtml || !draft || !filePath) return draft;
    const dirSegments = filePath.split("/").slice(0, -1);
    const encodedDir = dirSegments.map(encodeURIComponent).join("/");
    const base = `${window.location.origin}/api/workspaces/${workspaceId}/serve/${encodedDir}/`;
    const apiBase = `/api/workspaces/${workspaceId}/proxy`;
    const baseTag = `<base href="${base}"><script>window.API_BASE=${JSON.stringify(apiBase)}</script>`;
    const html = /<head(\s[^>]*)?>/.test(draft)
      ? draft.replace(/<head(\s[^>]*)?>/, `$&${baseTag}`)
      : baseTag + draft;
    return `<!--v:${previewKey}-->${html}`;
  }, [draft, filePath, isHtml, workspaceId, previewKey]);

  const highlightedHtml = useMemo(() => {
    if (!draft || fileType !== "text") return draft ?? "";
    if (lang === "txt") return draft.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    try {
      return (lang ? hljs.highlight(draft, { language: lang }) : hljs.highlightAuto(draft)).value;
    } catch {
      return hljs.highlightAuto(draft).value;
    }
  }, [draft, lang, fileType]);

  const jsonParsed = useMemo<object | null>(() => {
    if (lang !== "json" || !draft) return null;
    try { return JSON.parse(draft) as object; } catch { return null; }
  }, [draft, lang]);

  const isDirty = fileType === "text" && draft !== content;
  isDirtyRef.current = isDirty;
  const displayPath = filePath ? filePath.split("/").slice(-3).join("/") : "";
  const rawUrl = filePath
    ? `/api/workspaces/${workspaceId}/files/content?path=${encodeURIComponent(filePath)}&raw=1`
    : "";

  const closeBtn = (
    <button className="iconbtn" onClick={onClose} title="Close viewer" aria-label="Close viewer">
      <CloseIcon />
    </button>
  );

  if (!filePath) {
    return (
      <div className="flex flex-col min-h-0 flex-1">
        <div className="flex items-center gap-2.5 px-4 min-h-[44px] border-b border-border bg-bg flex-shrink-0">
          <span className="font-mono text-[13px] text-text-3 flex-1 min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">No file open</span>
          {closeBtn}
        </div>
        <div className="flex-1 grid place-items-center text-text-3 text-sm bg-bg-tint p-6 text-center">
          Select a file from the tree to view its contents
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col min-h-0 flex-1">
      <div className="flex items-center gap-2.5 px-4 min-h-[44px] border-b border-border bg-bg flex-shrink-0">
        <span className="font-mono text-[13px] text-text-2 flex-1 min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">
          {displayPath}
        </span>
        {!loading && !error && fileType !== null && (
          <>
            {fileType === "text" && (lang === "markdown" || isHtml || lang === "json") && (
              <button className="btn btn-sm" onClick={() => setShowPreview(v => !v)}
                title={showPreview ? "Switch to editor" : "Switch to preview"}>
                {showPreview ? "Code" : "Preview"}
              </button>
            )}
            {fileType === "text" && (
              <button
                className="btn btn-sm btn-primary"
                onClick={handleSave}
                disabled={!isDirty || saving}
              >
                {saving ? "Saving…" : "Save"}
              </button>
            )}
            <button
              className="btn btn-sm text-danger"
              onClick={handleDelete}
              disabled={deleting}
            >
              {deleting ? "Deleting…" : "Delete"}
            </button>
          </>
        )}
        {closeBtn}
      </div>

      {loading && <div className="flex-1 grid place-items-center text-text-3 text-sm bg-bg-tint p-6 text-center">Loading…</div>}
      {error && <div className="flex-1 grid place-items-center text-sm bg-bg-tint p-6 text-center text-danger">{error}</div>}

      {!loading && !error && fileType === "image" && (
        <div className="flex-1 grid place-items-center bg-bg-tint overflow-auto p-4">
          <img src={rawUrl} alt={filePath.split("/").pop()} className="max-w-full object-contain rounded" />
        </div>
      )}

      {!loading && !error && fileType === "binary" && (
        <div className="flex-1 grid place-items-center text-text-3 text-sm bg-bg-tint p-6 text-center">
          Binary file — cannot be previewed
        </div>
      )}

      {!loading && !error && fileType === "text" && content !== null && (
        <div className="code-editor-wrap">
          {showPreview ? (
            lang === "json" ? (
              jsonParsed !== null
                ? <JSONCrack key={previewKey} json={jsonParsed} theme="light" showGrid={false} className="json-preview" />
                : <div className="flex-1 grid place-items-center text-text-2 text-sm bg-bg-tint p-6 text-center">File too big for preview</div>
            ) : isHtml ? (
              <iframe key={previewKey} className="html-preview" srcDoc={htmlForPreview}
                sandbox="allow-scripts allow-forms allow-same-origin" title="HTML preview" />
            ) : (
              <div className="md-preview md-prose">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{draft ?? ""}</ReactMarkdown>
              </div>
            )
          ) : (
            <>
              <div className="code-editor-gutter" ref={gutterRef} aria-hidden="true">
                {draft.split("\n").map((_, i) => (
                  <div key={i} className="code-editor-ln">{i + 1}</div>
                ))}
              </div>
              <div className="code-editor-body">
                <pre className="code-editor-hl" ref={preRef} aria-hidden="true"
                  dangerouslySetInnerHTML={{ __html: highlightedHtml + "\n" }} />
                <textarea ref={taRef} className="code-editor-input" value={draft}
                  onChange={e => setDraft(e.target.value)} onScroll={syncScroll}
                  spellCheck={false} wrap="off" />
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
});

export default FileViewer;
