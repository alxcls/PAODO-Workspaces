import { type NextRequest, NextResponse } from "next/server";
import { requireWorkspace } from "@/lib/api/guards";
import { listSecretMeta, setSecret, getWorkspaceRules, normalizeDomain } from "@/lib/infra/security/workspaceSecretStore";
import { getCredentialProxy } from "@/lib/infra/proxy";

const NAME_RE = /^[A-Z_][A-Z0-9_]*$/;
// Bare hostname: labels of letters/digits/hyphens separated by dots, at least one dot.
const DOMAIN_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/;

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const ws = requireWorkspace(id);
  if (ws instanceof NextResponse) return ws;
  return NextResponse.json(listSecretMeta(id));
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const ws = requireWorkspace(id);
  if (ws instanceof NextResponse) return ws;

  const body = (await req.json()) as { name?: string; value?: string; domains?: string[] };
  const { name, value } = body;

  if (!name || !NAME_RE.test(name)) {
    return NextResponse.json({ error: "name must be uppercase letters, digits, and underscores (e.g. OPENAI_KEY)" }, { status: 400 });
  }
  if (!value?.trim()) return NextResponse.json({ error: "value required" }, { status: 400 });

  // Validate shape only — reject an empty list or a host that isn't a bare hostname. Canonicalization
  // (normalize + dedup + sort) is owned by setSecret's sanitizeDomains, so we pass the raw hosts
  // through rather than duplicate that logic here.
  if (!Array.isArray(body.domains) || body.domains.length === 0) {
    return NextResponse.json({ error: "add at least one allowed host" }, { status: 400 });
  }
  for (const raw of body.domains) {
    if (!DOMAIN_RE.test(normalizeDomain(raw ?? ""))) {
      return NextResponse.json({ error: "each allowed host must be a hostname the key is sent to (e.g. api.openai.com)" }, { status: 400 });
    }
  }

  setSecret(id, name, value, body.domains);
  getCredentialProxy().setRules(id, getWorkspaceRules(id));

  return NextResponse.json(listSecretMeta(id).find((s) => s.name === name));
}
