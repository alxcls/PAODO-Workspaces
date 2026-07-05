// Agent tool that fetches a URL and returns its content as plain text.
// Strips scripts, styles, and HTML tags from HTML responses. Enforces HTTPS and caps output at 20 000 characters.
// Higher than the general tool-result cap (10k) because web pages are dense and need more room to be useful.

import { StructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import { assertPublicUrl } from "../ssrfGuard";
import { toolError } from "../toolUtils";

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 5;

// Follows redirects MANUALLY so the SSRF guard runs on every hop. The default fetch redirect-follow
// would re-guard nothing: a public host could 302 to http://169.254.169.254 and reach internal
// services unchecked. By disabling auto-follow and re-running assertPublicUrl on each Location, the
// guarantee "every URL we actually open is public" holds across the whole chain, not just the first
// request. Returns the response plus the final guarded URL for display.
async function fetchGuarded(rawUrl: string, signal: AbortSignal): Promise<{ res: Response; url: string }> {
  let url = await assertPublicUrl(rawUrl);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; ShellCopilot/1.0)" },
      redirect: "manual",
      signal,
    });
    if (!REDIRECT_STATUSES.has(res.status)) return { res, url };
    const location = res.headers.get("location");
    if (!location) return { res, url }; // 3xx with no target — let the caller handle the status
    // Resolve relative redirects against the current URL, then re-guard before following.
    url = await assertPublicUrl(new URL(location, url).toString());
  }
  throw new Error(`Too many redirects (>${MAX_REDIRECTS})`);
}

const schema = z.object({
  url: z.string().describe("Fully-formed URL to fetch"),
  prompt: z.string().optional().describe("What to extract or focus on from the page"),
});

function htmlToText(html: string): string {
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

export class WebFetchTool extends StructuredTool<typeof schema> {
  name = "http_get";
  description = `Make an HTTP GET request to any public URL and return the response body as plain text.
This is a server-side request executed by the platform — always call this tool when the user provides a URL or asks for web content.
HTTP URLs are automatically upgraded to HTTPS.
Use the prompt field to describe what to extract from the response.
For GitHub repos/PRs/issues, prefer gh CLI via execute_command instead.`;
  schema = schema;

  protected async _call({ url, prompt }: z.infer<typeof schema>): Promise<string> {
    try {
      const { res, url: finalUrl } = await fetchGuarded(url, AbortSignal.timeout(15_000));
      if (!res.ok) return `Error: HTTP ${res.status} ${res.statusText} — ${finalUrl}`;
      const contentType = res.headers.get("content-type") ?? "";
      let text = await res.text();
      if (contentType.includes("text/html")) text = htmlToText(text);
      const MAX_CHARS = 20_000;
      const capped = text.length > MAX_CHARS
        ? text.slice(0, MAX_CHARS) + `\n\n[content truncated — showing first ${MAX_CHARS} chars]`
        : text;
      return prompt
        ? `Fetched: ${finalUrl}\nPrompt: ${prompt}\n\n${capped}`
        : `Fetched: ${finalUrl}\n\n${capped}`;
    } catch (err: unknown) {
      return toolError(err);
    }
  }
}
