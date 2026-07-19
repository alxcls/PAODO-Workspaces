// Lists the models available for a provider, drawn from the code-owned model catalog. Drives the
// per-workspace model picker: GET /api/models?provider=deepseek -> { models: ["deepseek-v4-pro", ...] }.
// Returns the providers too so the UI can render the provider dropdown from one source — filtered to
// those with an API key configured, so the picker never offers a provider .env can't authenticate. Plus
// reasoningEfforts — the exact effort levels this provider accepts — so the picker populates the effort
// dropdown from the same source of truth the API validates against (empty = provider has no effort dial,
// so the UI hides the control).
import { type NextRequest, NextResponse } from "next/server";
import { listModels } from "@/lib/workspace/models";
import { configuredProviders, getProviderMetadata } from "@/lib/agent/buildModel";

export async function GET(req: NextRequest) {
  const provider = req.nextUrl.searchParams.get("provider") ?? "";
  const models = provider ? listModels(provider) : [];
  const reasoningEfforts = provider ? getProviderMetadata(provider).reasoningEfforts : [];
  return NextResponse.json({ providers: configuredProviders(), models, reasoningEfforts });
}
