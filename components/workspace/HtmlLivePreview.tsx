// Live HTML preview for WORKSPACE files: the iframe runs at an opaque (null) origin and reaches its
// own workspace's backend through the proxy/serve routes, authenticating with a per-workspace
// preview token instead of the user's Basic Auth. This is the script-enabled path — only safe for a
// single-owner workspace, never for shared drives (see HtmlStaticPreview for the drive-safe render).
"use client";

import { useState, useEffect, useMemo, useRef } from "react";

interface Props {
  workspaceId: string;
  /** API base for file routes, e.g. /api/workspaces/<id>. */
  base: string;
  /** Current editor content to render. */
  draft: string;
  /** Absolute path of the file being previewed. */
  filePath: string;
  /** Bumps to force the iframe to reload on save/external change. */
  previewKey: number;
  /** Reports the absolute workspace path of each resource the page fetches, so the parent can
   * reload the preview when one of *those* files changes (runtime dependency tracking). */
  onDependency?: (path: string) => void;
}

export default function HtmlLivePreview({ workspaceId, base, draft, filePath, previewKey, onDependency }: Props) {
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
    let cancelled = false;
    setTokenReady(false);
    fetch(`${base}/preview-token`)
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (!cancelled && d?.token) setTokenEntry({ ws: workspaceId, token: d.token as string }); })
      .catch(() => {})
      .finally(() => { if (!cancelled) setTokenReady(true); });
    return () => { cancelled = true; };
  }, [workspaceId, base]);
  const previewToken = tokenEntry?.ws === workspaceId ? tokenEntry.token : null;

  // The dependency-report listener must not re-subscribe when the callback identity changes, so read
  // the latest onDependency through a ref instead of listing it in the effect's deps.
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const onDependencyRef = useRef(onDependency);
  useEffect(() => { onDependencyRef.current = onDependency; });
  useEffect(() => {
    function onMessage(e: MessageEvent) {
      // Only trust messages from our own preview iframe. Its origin is "null" (sandboxed, no
      // allow-same-origin), so we can't check e.origin — identify it by its window instead.
      if (!iframeRef.current || e.source !== iframeRef.current.contentWindow) return;
      const d = e.data as { __paodoDep?: unknown; path?: unknown };
      if (d && d.__paodoDep === 1 && typeof d.path === "string") onDependencyRef.current?.(d.path);
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  const htmlForPreview = useMemo(() => {
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
    // Absolute workspace dir of the previewed HTML (trailing slash). A relative fetch resolves under
    // serveBase, so stripping that prefix and prepending this dir recovers the fetched file's real
    // workspace path — which is what the file-change socket broadcasts, letting the parent match it.
    const previewDir = filePath.slice(0, filePath.lastIndexOf("/") + 1);
    // Shim rewrites root-relative fetches (app-API calls) to the workspace proxy and attaches the
    // preview token as a Bearer header — those are fetch()-driven so a header works. Relative fetches
    // resolve via <base> to the serve route and authenticate through the path token above instead.
    // _rep additionally reports every fetch that resolves to a workspace file (under serveBase) up to
    // the parent via postMessage, so the parent can reload the preview when that file later changes.
    const baseTag = `<base href="${serveBase}"><script>window.API_BASE=${JSON.stringify(apiProxyBase)};window.PREVIEW_TOKEN=${JSON.stringify(previewToken ?? "")};window.__PREVIEW_DIR=${JSON.stringify(previewDir)};window.__SERVE_BASE=${JSON.stringify(serveBase)};(function(){var _f=window.fetch;function _rep(u){try{var abs=new URL(u,document.baseURI).href;var sb=window.__SERVE_BASE;if(sb&&abs.indexOf(sb)===0){var rel=decodeURIComponent(abs.slice(sb.length).split('#')[0].split('?')[0]);if(rel)window.parent.postMessage({__paodoDep:1,path:window.__PREVIEW_DIR+rel},'*');}}catch(e){}}window.fetch=function(r,o){var u=typeof r==='string'?r:(r instanceof Request?r.url:String(r));_rep(u);if(u.startsWith('/')&&!u.startsWith('//')){var rw=window.API_BASE+u;var h=new Headers((o&&o.headers)||(r instanceof Request?r.headers:undefined));if(window.PREVIEW_TOKEN)h.set('Authorization','Bearer '+window.PREVIEW_TOKEN);var init=Object.assign({},o,{headers:h});return _f(typeof r==='string'?rw:new Request(rw,r),init);}return _f(r,o);};})();</script>`;
    const html = /<head(\s[^>]*)?>/.test(draft)
      ? draft.replace(/<head(\s[^>]*)?>/, `$&${baseTag}`)
      : baseTag + draft;
    return `<!--v:${previewKey}-->${html}`;
  }, [draft, filePath, base, previewKey, previewToken]);

  if (!tokenReady) {
    return <div className="flex-1 grid place-items-center text-text-3 text-sm bg-bg-tint p-6 text-center">Loading preview…</div>;
  }
  if (!previewToken) {
    return <div className="flex-1 grid place-items-center text-danger text-sm bg-bg-tint p-6 text-center">Preview unavailable — could not obtain a preview token.</div>;
  }
  return (
    <iframe ref={iframeRef} key={previewKey} className="html-preview" srcDoc={htmlForPreview}
      sandbox="allow-scripts allow-forms" title="HTML preview" />
  );
}
