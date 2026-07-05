// Per-workspace "preview token" used to authenticate the HTML-preview iframe to its OWN
// workspace's proxy/serve routes WITHOUT the user's ambient Basic Auth.
//
// Why this exists: the preview iframe runs at an opaque (null) origin (no allow-same-origin),
// so it can no longer ride the user's Basic Auth session into the app API or other workspaces.
// To keep agent-built full-stack previews working, the iframe is handed a token scoped to its
// single workspace; server.ts accepts it as a Basic-Auth bypass for that workspace's
// proxy/serve routes only. The token is derived (HMAC) from a server secret + workspaceId, so
// nothing per-workspace is persisted and it can be both injected and validated on demand.
//
// Leaking the token to the agent is harmless: it only unlocks the agent's own backend, which
// the agent already fully controls.
import { createHmac, randomBytes, timingSafeEqual } from "crypto";
import path from "path";
import { WORKSPACES_ROOT } from "../paths";
import { atomicSaveJson, readJson } from "../jsonPersist";
import { globalSingleton } from "../globalSingleton";
import { createLogger } from "../logger";

const log = createLogger("previewToken");
const SECRET_FILE = path.join(WORKSPACES_ROOT, ".preview-secret.json");

// Resolve a stable server secret: env override first, else a persisted random secret generated
// once. Cached on global so Next.js hot-reload doesn't regenerate it.
function loadSecret(): string {
  if (process.env.PREVIEW_TOKEN_SECRET) return process.env.PREVIEW_TOKEN_SECRET;
  return globalSingleton("previewSecret", () => {
    const existing = readJson<{ secret?: string }>(SECRET_FILE, {}).secret;
    if (existing) return existing;
    const secret = randomBytes(32).toString("hex");
    try {
      atomicSaveJson(SECRET_FILE, { secret });
    } catch (err) {
      log.error({ err }, "failed to persist preview secret — using in-memory secret for this process");
    }
    return secret;
  });
}

export function getPreviewToken(workspaceId: string): string {
  return createHmac("sha256", loadSecret()).update(`preview:${workspaceId}`).digest("hex");
}

export function validatePreviewToken(workspaceId: string, token: string): boolean {
  const expected = getPreviewToken(workspaceId);
  const a = Buffer.from(token);
  const b = Buffer.from(expected);
  if (a.byteLength !== b.byteLength) {
    timingSafeEqual(Buffer.alloc(1), Buffer.alloc(1)); // length-oracle-safe dummy compare
    return false;
  }
  return timingSafeEqual(a, b);
}
