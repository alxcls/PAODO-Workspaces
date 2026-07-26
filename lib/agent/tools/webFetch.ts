// Agent tool that fetches a URL and returns its content as plain text.
// Strips scripts, styles, and HTML tags from HTML responses. Enforces HTTPS and caps output at 20 000 characters.
// Higher than the general tool-result cap (10k) because web pages are dense and need more room to be useful.
//
// The fetch runs INSIDE the workspace container (curl via ExecRunner), not in the app process. That
// is deliberate and load-bearing: in the app's network namespace 127.0.0.1 is the platform server
// itself, socket-proxy:2375 is a Docker API grant, and 169.254.169.254 is host IAM credentials — so
// an app-side fetch of an agent-supplied URL is a privilege escalation that has to be talked back
// down by an allow/deny guard. In-container it is simply the reachability the agent already has via
// execute_command, enforced by the network namespace rather than by parsing strings. It also means
// an internet-access-off workspace (whose network is created --internal) cannot fetch at all, the
// same network-layer boundary apt_install gets — not merely an unbound tool.
//
// Traffic transits the credential proxy (HTTP_PROXY is set in the container by
// containerCredentials.ts), which applies destinationGuard's SSRF checks and audit logging to every
// hop. Never pass --noproxy here: the proxy is what makes that guarantee hold, since HTTP_PROXY is
// env-var convention rather than iptables. The one documented exception is the container's own
// loopback — containerCredentials.ts sets no_proxy=localhost,127.0.0.1,0.0.0.0,::1 so a workspace
// can reach its own dev server — which goes direct and unaudited. That is deliberate and not a
// widening: it is the container's own loopback, which execute_command already reaches, and no_proxy
// matches on the host string, so a hostname that merely *resolves* to 127.0.0.1 still transits the
// proxy and is still guarded. A consequence of routing through it is that http_get is
// on the credential path — a fetch to a domain with a configured secret rule gets the real value
// substituted in (exact-host only, HTTPS only, responses redacted; see credentialProxy.ts).

import { StructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import { toolError } from "../toolUtils";
import type { ExecRunner } from "../interfaces";

const MAX_REDIRECTS = 5;
const REQUEST_TIMEOUT_SECONDS = 15;
// Bounds a hostile or oversized response. Hard cap for responses that declare a length (curl also
// aborts in-flight transfers past it); a chunked response with no declared length is bounded by
// --max-time instead. Downstream we keep at most MAX_CHARS of text anyway.
const READ_CAP_BYTES = 8 * 1024 * 1024;
const MAX_CHARS = 20_000;
const USER_AGENT = "Mozilla/5.0 (compatible; ShellCopilot/1.0)";

// curl writes these three fields to stderr (via %{stderr}) so stdout stays a clean body — no
// delimiter that a response could collide with. Tab-separated because none of the three can contain
// a tab: an HTTP status code, a Content-Type, and a URL.
const WRITE_OUT = "%{stderr}%{http_code}\t%{content_type}\t%{url_effective}";

const schema = z.object({
  url: z.string().describe("Fully-formed URL to fetch"),
  prompt: z.string().optional().describe("What to extract or focus on from the page"),
});

// Upgrade http → https and refuse every other scheme. Pure string work (no DNS, no connection): this
// is not an SSRF control — the proxy owns that — it keeps the request off cleartext, which also
// matters because the credential proxy only ever substitutes secrets on HTTPS. Scheme match is
// case-insensitive: URL lowercases the protocol, so a literal-prefix test would send "HTTP://x" to
// the refusal branch instead of upgrading it, contradicting this tool's own description.
// Covers the entry URL only — redirect hops are held to https by --proto-redir in buildCurlArgs.
function normalizeUrl(rawUrl: string): string {
  const upgraded = /^http:\/\//i.test(rawUrl) ? rawUrl.replace(/^http:\/\//i, "https://") : rawUrl;
  let parsed: URL;
  try {
    parsed = new URL(upgraded);
  } catch {
    throw new Error("Invalid URL");
  }
  if (parsed.protocol !== "https:") throw new Error("Only HTTPS URLs are allowed");
  return upgraded;
}

// argv only — no shell — so the URL can never be interpolated into a command string.
export function buildCurlArgs(url: string): string[] {
  return [
    "curl",
    // Silent, but still report real errors on stderr so a failure has a usable message.
    "-sS",
    // Follow redirects in curl rather than hop-by-hop here: every hop transits the credential proxy,
    // which guards and audits each one.
    "-L",
    "--max-redirs",
    String(MAX_REDIRECTS),
    // normalizeUrl only sees the entry URL; -L would otherwise happily follow a 302 into cleartext.
    // These hold every hop to https, extending normalizeUrl's no-cleartext rule across the chain
    // (the app-side guard this replaced re-validated each Location itself). curl refuses the hop
    // rather than upgrading it — an upgrade is not expressible here, and refusing is the safer end
    // of that trade. Secrets are never at risk on such a hop (the proxy substitutes on HTTPS only),
    // so this is about not putting the request itself on the wire in the clear.
    "--proto",
    "=https",
    "--proto-redir",
    "=https",
    // Doubles as the hang guard: ExecRunner.exec() has no abort plumbing, so curl must bound itself.
    "--max-time",
    String(REQUEST_TIMEOUT_SECONDS),
    "--max-filesize",
    String(READ_CAP_BYTES),
    // curl does not auto-decompress unless asked; request identity so response bytes are plain text.
    "-H",
    "Accept-Encoding: identity",
    "-A",
    USER_AGENT,
    "-w",
    WRITE_OUT,
    url,
  ];
}

interface FetchOutcome {
  status: number;
  contentType: string;
  finalUrl: string;
  body: string;
}

// curl's -w block is written last, so it is the final tab-delimited line on stderr; anything before
// it is curl's own diagnostics (-sS keeps real errors). Split rather than parsing the whole blob:
// curl still emits -w on failure (as `000\t\t`), so the two must not contaminate each other — the
// error message would otherwise carry metadata junk, and a stray warning would break the parse.
function splitStderr(stderr: string): { message: string; metaLine: string | null } {
  const lines = stderr.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/^\d+\t/.test(lines[i])) {
      return { message: lines.slice(0, i).join("\n").trim(), metaLine: lines[i] };
    }
  }
  return { message: stderr.trim(), metaLine: null };
}

function parseOutcome(stdout: string, metaLine: string | null, fallbackUrl: string): FetchOutcome {
  const [code, contentType = "", finalUrl = ""] = (metaLine ?? "").split("\t");
  const status = Number.parseInt(code ?? "", 10);
  if (!Number.isFinite(status)) throw new Error("could not read the response status");
  return { status, contentType, finalUrl: finalUrl || fallbackUrl, body: stdout };
}

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
Always call this tool when the user provides a URL or asks for web content.
HTTP URLs are automatically upgraded to HTTPS.
Use the prompt field to describe what to extract from the response.
For GitHub repos/PRs/issues, prefer gh CLI via execute_command instead.`;
  schema = schema;

  // Runs through the workspace container, like every other tool. Tests inject a fake runner.
  constructor(private readonly runner: ExecRunner) {
    super();
  }

  protected async _call({ url, prompt }: z.infer<typeof schema>): Promise<string> {
    try {
      const target = normalizeUrl(url);
      const r = await this.runner.exec(buildCurlArgs(target));
      const { message, metaLine } = splitStderr(r.stderr);
      if (r.code !== 0) return `Error: ${message || `request failed (curl exit ${r.code})`} — ${target}`;

      const { status, contentType, finalUrl, body } = parseOutcome(r.stdout, metaLine, target);
      if (status < 200 || status >= 300) return `Error: HTTP ${status} — ${finalUrl}`;

      let text = body;
      if (contentType.includes("text/html")) text = htmlToText(text);
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
