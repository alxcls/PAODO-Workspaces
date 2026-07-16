// Agent tool that fetches a URL and returns its content as plain text.
// Strips scripts, styles, and HTML tags from HTML responses. Enforces HTTPS and caps output at 20 000 characters.
// Higher than the general tool-result cap (10k) because web pages are dense and need more room to be useful.

import { StructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import https from "node:https";
import { isIPv6 } from "node:net";
import { assertPublicUrl } from "../ssrfGuard";
import { toolError } from "../toolUtils";

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 5;
const REQUEST_TIMEOUT_MS = 15_000;
// Raw-body read cap. Downstream we keep at most 20k chars of text; this bounds memory for a
// hostile or oversized response well above that (HTML strips down a lot) without being unbounded.
const READ_CAP_BYTES = 8 * 1024 * 1024;

// A single completed GET, reduced to just what the tool needs. Bodies are already read and decoded
// so the injectable requester below has a simple, side-effect-free contract.
export interface GuardedResponse {
  status: number;
  statusText: string;
  contentType: string;
  location: string | null;
  body: string;
}

// Issues one GET, pinning the TCP connection to `pinnedIp` — the exact address assertPublicUrl
// validated — while leaving TLS SNI + certificate validation bound to the URL's hostname. This is
// what closes the DNS-rebinding window: the guard resolves and approves an IP, and we connect to
// THAT IP, so a hostile resolver cannot hand the socket a different (private) address afterward.
// Injectable so tests exercise the redirect/guard wiring without opening real sockets.
export type Requester = (url: string, pinnedIp: string, signal: AbortSignal) => Promise<GuardedResponse>;

const defaultRequester: Requester = (url, pinnedIp, signal) =>
  new Promise<GuardedResponse>((resolve, reject) => {
    const family = isIPv6(pinnedIp) ? 6 : 4;
    const req = https.request(
      url,
      {
        method: "GET",
        headers: {
          "User-Agent": "Mozilla/5.0 (compatible; ShellCopilot/1.0)",
          // node:https does not auto-decompress; ask for identity so response bytes are plain text.
          "Accept-Encoding": "identity",
        },
        // Force the socket to the pre-validated IP. Node still sets `servername` from the URL host,
        // so TLS certificate validation runs against the hostname — only the connect target is
        // pinned. This is the whole point of the guard returning `ip`.
        lookup: (_hostname, opts, cb) => {
          if (opts && (opts as { all?: boolean }).all) {
            (cb as unknown as (e: null, a: Array<{ address: string; family: number }>) => void)(null, [
              { address: pinnedIp, family },
            ]);
          } else {
            (cb as unknown as (e: null, a: string, f: number) => void)(null, pinnedIp, family);
          }
        },
        signal,
      },
      (res) => {
        const status = res.statusCode ?? 0;
        const location = (res.headers.location as string | undefined) ?? null;
        const contentType = (res.headers["content-type"] as string | undefined) ?? "";
        const decoder = new TextDecoder("utf-8", { fatal: false });
        let body = "";
        let bytes = 0;
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          body += decoder.decode(); // flush any trailing multi-byte sequence
          resolve({ status, statusText: res.statusMessage ?? "", contentType, location, body });
        };
        res.on("data", (chunk: Buffer) => {
          if (settled) return;
          bytes += chunk.length;
          body += decoder.decode(chunk, { stream: true });
          if (bytes > READ_CAP_BYTES) {
            finish(); // cap hit — take what we have and tear the socket down
            res.destroy();
          }
        });
        res.on("end", finish);
        res.on("error", (err) => {
          if (settled) return;
          settled = true;
          reject(err);
        });
      },
    );
    req.on("error", reject);
    req.end();
  });

// Follows redirects MANUALLY so the SSRF guard runs on every hop. Auto-follow would re-guard
// nothing: a public host could 302 to https://169.254.169.254 and reach internal services
// unchecked. By re-running assertPublicUrl on each Location (and pinning to the IP it returns), the
// guarantee "every address we actually dial is public" holds across the whole chain. Returns the
// response plus the final guarded URL for display.
async function fetchGuarded(
  rawUrl: string,
  signal: AbortSignal,
  requester: Requester,
): Promise<{ res: GuardedResponse; url: string }> {
  let { url, ip } = await assertPublicUrl(rawUrl);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const res = await requester(url, ip, signal);
    if (!REDIRECT_STATUSES.has(res.status)) return { res, url };
    if (!res.location) return { res, url }; // 3xx with no target — let the caller handle the status
    // Resolve relative redirects against the current URL, then re-guard (and re-pin) before following.
    ({ url, ip } = await assertPublicUrl(new URL(res.location, url).toString()));
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

  // Requester defaults to the real pinned-https implementation; tests inject a fake to drive the
  // guard/redirect wiring without sockets. buildTools constructs this with no args.
  constructor(private readonly requester: Requester = defaultRequester) {
    super();
  }

  protected async _call({ url, prompt }: z.infer<typeof schema>): Promise<string> {
    try {
      const { res, url: finalUrl } = await fetchGuarded(url, AbortSignal.timeout(REQUEST_TIMEOUT_MS), this.requester);
      const ok = res.status >= 200 && res.status < 300;
      if (!ok) return `Error: HTTP ${res.status} ${res.statusText} — ${finalUrl}`;
      let text = res.body;
      if (res.contentType.includes("text/html")) text = htmlToText(text);
      const MAX_CHARS = 20_000;
      const capped =
        text.length > MAX_CHARS
          ? text.slice(0, MAX_CHARS) + `\n\n[content truncated — showing first ${MAX_CHARS} chars]`
          : text;
      return prompt ? `Fetched: ${finalUrl}\nPrompt: ${prompt}\n\n${capped}` : `Fetched: ${finalUrl}\n\n${capped}`;
    } catch (err: unknown) {
      return toolError(err);
    }
  }
}
