import { type NextRequest, NextResponse } from "next/server";
import { getStore } from "@/lib/infra/services";
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
  if (!getStore().getWorkspace(id)) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json(listSecretMeta(id));
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (!getStore().getWorkspace(id)) return NextResponse.json({ error: "not found" }, { status: 404 });

  const body = (await req.json()) as { name?: string; value?: string; domain?: string };
  const { name, value } = body;

  if (!name || !NAME_RE.test(name)) {
    return NextResponse.json({ error: "name must be uppercase letters, digits, and underscores (e.g. OPENAI_KEY)" }, { status: 400 });
  }
  if (!value?.trim()) return NextResponse.json({ error: "value required" }, { status: 400 });

  const domain = normalizeDomain(body.domain ?? "");
  if (!domain || !DOMAIN_RE.test(domain)) {
    return NextResponse.json({ error: "domain must be a hostname the key is sent to (e.g. api.openai.com)" }, { status: 400 });
  }

  setSecret(id, name, value, domain);
  getCredentialProxy().setRules(id, getWorkspaceRules(id));

  return NextResponse.json(listSecretMeta(id).find((s) => s.name === name));
}
