// Scriptless static HTML preview for DRIVE files. Drives are shared, multi-tenant storage, so a
// previewed .html may be untrusted content authored by a different tenant. Unlike the workspace
// live preview, this path runs NO scripts (sandbox="") and blocks ALL network egress via a strict
// CSP, so it cannot exfiltrate, beacon, phish, or pivot. Good for self-contained reports (inline
// CSS, inline SVG, base64 images); external/relative subresources intentionally won't load.
"use client";

// default-src 'none' kills scripts and all fetches; inline styles are allowed so reports render;
// img/font are limited to data: URIs (no external loads, no tracking beacons); base-uri 'none'
// blocks <base> hijacking. This is defense-in-depth on top of the empty iframe sandbox.
const STATIC_PREVIEW_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; base-uri 'none'";

/**
 * Wrap raw HTML for the scriptless preview: inject the locked-down CSP <meta> (after <head> if one
 * exists, else prepend) and a `<!--v:KEY-->` cache-buster so the iframe reloads on save. No <base>,
 * no token, no fetch-shim — the static preview never talks to any backend.
 */
export function buildStaticPreviewHtml(draft: string, previewKey: number): string {
  const meta = `<meta http-equiv="Content-Security-Policy" content="${STATIC_PREVIEW_CSP}">`;
  const html = /<head(\s[^>]*)?>/.test(draft)
    ? draft.replace(/<head(\s[^>]*)?>/, `$&${meta}`)
    : meta + draft;
  return `<!--v:${previewKey}-->${html}`;
}

interface Props {
  /** Current editor content to render. */
  draft: string;
  /** Bumps to force the iframe to reload on save/external change. */
  previewKey: number;
}

export default function HtmlStaticPreview({ draft, previewKey }: Props) {
  return (
    <iframe key={previewKey} className="html-preview" srcDoc={buildStaticPreviewHtml(draft, previewKey)}
      sandbox="" title="HTML preview" />
  );
}
