// Centre pane that loads and displays workspace files with syntax highlighting and inline editing.
// Listens to WebSocket file-change events to auto-reload the open file when the agent modifies it,
// but suppresses reload when the user has unsaved local edits.
"use client";

import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import hljs from "@/lib/highlighter";
import { marked } from "marked";
import DOMPurify from "dompurify";

function detectLang(filePath: string): string {
  const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
  const map: Record<string, string> = {
    // extension differs from hljs language id — auto-detect can't infer these
    ts: "typescript", tsx: "typescript",
    js: "javascript", jsx: "javascript",
    py: "python", rb: "ruby", rs: "rust",
    cs: "csharp", kt: "kotlin", kts: "kotlin",
    sh: "bash", zsh: "bash",
    html: "xml", htm: "xml", svg: "xml",
    yml: "yaml", tf: "hcl", toml: "ini",
    gql: "graphql", proto: "protobuf", ps1: "powershell",
    md: "markdown",
    txt: "txt",
  };
  return map[ext] ?? "";
}

const CloseIcon = () => (
  <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
    <path d="M4 4l8 8M12 4l-8 8" />
  </svg>
);

interface Props {
  workspaceId: string;
  filePath: string | null;
  onClose: () => void;
  onDeleted?: () => void;
}

export default function FileViewer({ workspaceId, filePath, onClose, onDeleted }: Props) {
  const [fileType, setFileType] = useState<"text" | "image" | "binary" | null>(null);
  const [content, setContent] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [mdPreview, setMdPreview] = useState(false);
  const preRef = useRef<HTMLPreElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const gutterRef = useRef<HTMLDivElement>(null);
  const wsRef = useRef<WebSocket | null>(null);

  const filePathRef = useRef<string | null>(filePath);
  useEffect(() => { filePathRef.current = filePath; }, [filePath]);
  const isDirtyRef = useRef(false);
  const onCloseRef = useRef(onClose);
  useEffect(() => { onCloseRef.current = onClose; }, [onClose]);

  const lang = filePath ? detectLang(filePath) : "txt";

  const fetchContent = useCallback(
    async (path: string, silent = false) => {
      if (!silent) {
        setLoading(true);
        setFileType(null);
        setContent(null);
        setDraft("");
      }
      setError(null);
      try {
        const res = await fetch(
          `/api/workspaces/${workspaceId}/files/content?path=${encodeURIComponent(path)}`
        );
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
    },
    [workspaceId]
  );

  useEffect(() => {
    if (filePath) fetchContent(filePath);
    else { setFileType(null); setContent(null); setDraft(""); }
    setMdPreview(lang === "markdown");
  }, [filePath, fetchContent, lang]);

  useEffect(() => {
    const ws = new WebSocket(`ws://${window.location.host}/ws?workspaceId=${workspaceId}`);
    wsRef.current = ws;
    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data as string) as { type: string; paths?: string[] };
        if (msg.type === "files_changed" && msg.paths?.includes(filePathRef.current ?? "") && !isDirtyRef.current) {
          fetchContent(filePathRef.current!, true);
        }
        if (msg.type === "files_deleted" && msg.paths?.includes(filePathRef.current ?? "")) {
          onCloseRef.current();
        }
      } catch { /* ignore */ }
    };
    ws.onclose = () => { if (wsRef.current === ws) wsRef.current = null; };
    return () => { ws.close(); wsRef.current = null; };
  }, [workspaceId, fetchContent]);

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
      await fetch(`/api/workspaces/${workspaceId}/files/content?path=${encodeURIComponent(filePath)}`, { method: "DELETE" });
      onClose();
      onDeleted?.();
    } catch {
      setError("Delete failed");
    } finally {
      setDeleting(false);
    }
  }

  async function handleSave() {
    if (!filePath) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/workspaces/${workspaceId}/files/content`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: filePath, content: draft }),
      });
      if (!res.ok) { setError("Save failed"); return; }
      setContent(draft);
      if (wsRef.current?.readyState === 1) {
        wsRef.current.send(JSON.stringify({ type: "self_write", path: filePath }));
      }
    } catch {
      setError("Save failed");
    } finally {
      setSaving(false);
    }
  }

  const renderedMd = useMemo(() => {
    if (lang !== "markdown" || !mdPreview || !draft) return "";
    return DOMPurify.sanitize(marked.parse(draft));
  }, [draft, lang, mdPreview]);

  const highlightedHtml = useMemo(() => {
    if (!draft || fileType !== "text") return draft ?? "";
    if (lang === "txt") {
      return draft.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    }
    try {
      return (lang ? hljs.highlight(draft, { language: lang }) : hljs.highlightAuto(draft)).value;
    } catch {
      return hljs.highlightAuto(draft).value;
    }
  }, [draft, lang, fileType]);

  const isDirty = fileType === "text" && draft !== content;
  isDirtyRef.current = isDirty;
  const displayPath = filePath ? filePath.split("/").slice(-3).join("/") : "";
  const rawUrl = filePath
    ? `/api/workspaces/${workspaceId}/files/content?path=${encodeURIComponent(filePath)}&raw=1`
    : "";

  const closeBtn = (
    <button className="iconbtn viewer-close" onClick={onClose} title="Close viewer" aria-label="Close viewer">
      <CloseIcon />
    </button>
  );

  if (!filePath) {
    return (
      <div className="viewer">
        <div className="viewer-head">
          <span className="viewer-path" style={{ color: "var(--text-3)" }}>No file open</span>
          {closeBtn}
        </div>
        <div className="viewer-empty">Select a file from the tree to view its contents</div>
      </div>
    );
  }

  return (
    <div className="viewer">
      <div className="viewer-head">
        <span className="viewer-path">{displayPath}</span>
        {!loading && !error && fileType !== null && (
          <>
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
              className="btn btn-sm"
              onClick={handleDelete}
              disabled={deleting}
              style={{ color: "var(--danger)" }}
            >
              {deleting ? "Deleting…" : "Delete"}
            </button>
          </>
        )}
        {closeBtn}
      </div>

      {loading && <div className="viewer-empty">Loading…</div>}
      {error && <div className="viewer-empty" style={{ color: "var(--danger)" }}>{error}</div>}

      {/* Image preview */}
      {!loading && !error && fileType === "image" && (
        <div className="viewer-empty" style={{ overflow: "auto", padding: 16, alignItems: "flex-start" }}>
          <img
            src={rawUrl}
            alt={filePath.split("/").pop()}
            style={{ maxWidth: "100%", objectFit: "contain", borderRadius: 4 }}
          />
        </div>
      )}

      {/* Binary */}
      {!loading && !error && fileType === "binary" && (
        <div className="viewer-empty">Binary file — cannot be previewed</div>
      )}

      {/* Text editor */}
      {!loading && !error && fileType === "text" && content !== null && (
        <div className="code-editor-wrap" style={{ position: "relative" }}>
          {lang === "markdown" && (
            <button
              className="md-toggle-btn btn btn-sm"
              onClick={() => setMdPreview(v => !v)}
              title={mdPreview ? "Switch to editor" : "Switch to preview"}
            >
              {mdPreview ? "Edit" : "Preview"}
            </button>
          )}

          {mdPreview ? (
            <div
              className="md-preview"
              dangerouslySetInnerHTML={{ __html: renderedMd }}
            />
          ) : (
            <>
              <div className="code-editor-gutter" ref={gutterRef} aria-hidden="true">
                {draft.split("\n").map((_, i) => (
                  <div key={i} className="code-editor-ln">{i + 1}</div>
                ))}
              </div>
              <div className="code-editor-body">
                <pre
                  className="code-editor-hl"
                  ref={preRef}
                  aria-hidden="true"
                  dangerouslySetInnerHTML={{ __html: highlightedHtml + "\n" }}
                />
                <textarea
                  ref={taRef}
                  className="code-editor-input"
                  value={draft}
                  onChange={e => setDraft(e.target.value)}
                  onScroll={syncScroll}
                  spellCheck={false}
                  wrap="off"
                />
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
