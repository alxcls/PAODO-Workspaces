// Centre pane that displays workspace files with syntax highlighting and inline editing.
// File-change / file-delete notifications arrive via the imperative handle, called by the
// workspace page which owns the shared WebSocket. Data operations are handled by useFileContent.
"use client";

import { useState, useEffect, useRef, useMemo, forwardRef, useImperativeHandle } from "react";
import hljs from "@/lib/client/highlighter";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useFileContent } from "@/lib/client/hooks/useFileContent";

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
  /** API base for file routes. Defaults to the workspace path; drives pass /api/drives/<id>. */
  apiBase?: string;
  /** HTML live-preview needs a running container; off for drives (passive storage, no container). */
  enableHtmlPreview?: boolean;
}

const FileViewer = forwardRef<FileViewerHandle, Props>(function FileViewer(
  { workspaceId, filePath, onClose, onSelfWrite, apiBase, enableHtmlPreview = true },
  ref
) {
  const base = apiBase ?? `/api/workspaces/${workspaceId}`;
  const {
    fileType, content, draft, setDraft,
    loading, error, saving, deleting,
    isDirty, previewKey,
    handleSave, deleteFile,
    notifyFilesChanged, notifyFilesDeleted,
  } = useFileContent(workspaceId, filePath, { onClose, onSelfWrite, apiBase: base });

  const lang = filePath ? detectLang(filePath) : "txt";
  // HTML files render as live preview only when the backend can serve them through a container.
  const isHtml = /\.(html?|htm)$/i.test(filePath ?? "") && enableHtmlPreview;

  const [showPreview, setShowPreview] = useState(false);
  useEffect(() => {
    setShowPreview(lang === "markdown" || isHtml);
  }, [lang, isHtml]);

  // Per-workspace preview token: the preview iframe runs at an opaque origin (no allow-same-origin),
  // so it authenticates to its own workspace backend through the proxy with this token instead of
  // the user's session. Fetched once per workspace from the Basic-Auth-protected app API. Stored
  // with its workspace id so a stale token from a previous workspace is never injected.
  const [tokenEntry, setTokenEntry] = useState<{ ws: string; token: string } | null>(null);
  // `ready` flips once the fetch settles (success OR failure). We gate the iframe on it so the
  // preview never renders with an empty token and then has to reload — that first tokenless load
  // is what fired the cross-origin/401 errors users saw until they toggled Code→Preview.
  const [tokenReady, setTokenReady] = useState(false);
  useEffect(() => {
    if (!enableHtmlPreview) { setTokenReady(true); return; }
    let cancelled = false;
    setTokenReady(false);
    fetch(`${base}/preview-token`)
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (!cancelled && d?.token) setTokenEntry({ ws: workspaceId, token: d.token as string }); })
      .catch(() => {})
      .finally(() => { if (!cancelled) setTokenReady(true); });
    return () => { cancelled = true; };
  }, [workspaceId, base, enableHtmlPreview]);
  const previewToken = tokenEntry?.ws === workspaceId ? tokenEntry.token : null;

  const preRef = useRef<HTMLPreElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const gutterRef = useRef<HTMLDivElement>(null);

  useImperativeHandle(ref, () => ({ notifyFilesChanged, notifyFilesDeleted }), [notifyFilesChanged, notifyFilesDeleted]);

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
    deleteFile();
  }

  const htmlForPreview = useMemo(() => {
    if (!isHtml || !draft || !filePath) return draft;
    // filePath is absolute, so split() yields a leading "" — drop it (filter) to avoid a double
    // slash (serve/TOKEN//Users), which Next.js 308-redirects to collapse, and that redirect carries
    // no CORS header so the browser blocks the subresource mid-redirect at the opaque origin.
    const dirSegments = filePath.split("/").slice(0, -1).filter(Boolean);
    const encodedDir = dirSegments.map(encodeURIComponent).join("/");
    // Token rides in the <base> PATH: tag-driven subresources (<link>, <script type=module> + nested
    // imports) are fetched from the opaque (null) origin and can carry neither Basic Auth nor a
    // header, and queries are dropped on relative resolution — only a path prefix survives to
    // authenticate them at the serve route (validated in server.ts).
    const serveBase = `${window.location.origin}${base}/serve/${encodeURIComponent(previewToken ?? "")}/${encodedDir}/`;
    const apiProxyBase = `${base}/proxy`;
    // Shim rewrites root-relative fetches (app-API calls) to the workspace proxy and attaches the
    // preview token as a Bearer header — those are fetch()-driven so a header works. Relative fetches
    // resolve via <base> to the serve route and authenticate through the path token above instead.
    const baseTag = `<base href="${serveBase}"><script>window.API_BASE=${JSON.stringify(apiProxyBase)};window.PREVIEW_TOKEN=${JSON.stringify(previewToken ?? "")};(function(){var _f=window.fetch;window.fetch=function(r,o){var u=typeof r==='string'?r:(r instanceof Request?r.url:String(r));if(u.startsWith('/')&&!u.startsWith('//')){var rw=window.API_BASE+u;var h=new Headers((o&&o.headers)||(r instanceof Request?r.headers:undefined));if(window.PREVIEW_TOKEN)h.set('Authorization','Bearer '+window.PREVIEW_TOKEN);var init=Object.assign({},o,{headers:h});return _f(typeof r==='string'?rw:new Request(rw,r),init);}return _f(r,o);};})();</script>`;
    const html = /<head(\s[^>]*)?>/.test(draft)
      ? draft.replace(/<head(\s[^>]*)?>/, `$&${baseTag}`)
      : baseTag + draft;
    return `<!--v:${previewKey}-->${html}`;
  }, [draft, filePath, isHtml, base, previewKey, previewToken]);

  const highlightedHtml = useMemo(() => {
    if (!draft || fileType !== "text") return draft ?? "";
    if (lang === "txt") return draft.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    try {
      return (lang ? hljs.highlight(draft, { language: lang }) : hljs.highlightAuto(draft)).value;
    } catch {
      return hljs.highlightAuto(draft).value;
    }
  }, [draft, lang, fileType]);

  const displayPath = filePath ? filePath.split("/").slice(-3).join("/") : "";
  const rawUrl = filePath
    ? `${base}/files/content?path=${encodeURIComponent(filePath)}&raw=1`
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
          <span className="font-mono text-ms text-text-3 flex-1 min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">No file open</span>
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
        <span className="font-mono text-ms text-text-2 flex-1 min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">
          {displayPath}
        </span>
        {!loading && !error && fileType !== null && (
          <>
            {fileType === "text" && (lang === "markdown" || isHtml) && (
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
            isHtml ? (
              !tokenReady ? (
                <div className="flex-1 grid place-items-center text-text-3 text-sm bg-bg-tint p-6 text-center">Loading preview…</div>
              ) : previewToken ? (
                <iframe key={previewKey} className="html-preview" srcDoc={htmlForPreview}
                  sandbox="allow-scripts allow-forms" title="HTML preview" />
              ) : (
                <div className="flex-1 grid place-items-center text-danger text-sm bg-bg-tint p-6 text-center">Preview unavailable — could not obtain a preview token.</div>
              )
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
