// Set (PUT) or clear (DELETE) one provider's API key.
//
// PUT rather than POST: there is exactly one key per provider and writing it again replaces it, so
// the operation is idempotent and the provider id in the path is the whole address. There is no
// rotation ceremony to model — unlike the bearer credentials this app mints, this value comes from
// the vendor, so "rotate" is just pasting the new one.
//
// Neither method is in platformAccessPolicy.ts, so the instance CLI token cannot call them. A leaked
// automation token must not be able to point the deployment's spend at someone else's account, nor
// delete the keys that make it work.
export const runtime = "nodejs";

import { type NextRequest, NextResponse } from "next/server";
import { appErrorResponse, errorResponse, readJsonObject } from "@/lib/api/errorResponse";
import { createLogger } from "@/lib/infra/logger";
import { removeProviderKey, storeProviderKey } from "@/lib/operations/settings/providerKeys";

const log = createLogger("api").child({ route: "provider-keys" });
const NO_STORE = { "Cache-Control": "no-store" } as const;

export async function PUT(req: NextRequest, { params }: { params: Promise<{ provider: string }> }) {
  const { provider } = await params;

  const parsed = await readJsonObject(req);
  if (parsed instanceof Response) return parsed;
  const body = parsed as { apiKey?: unknown };

  try {
    // The raw value is forwarded unchecked: the operation owns the "is this a key at all" rule, so
    // this route cannot state a narrower version of it — and must never inspect or log the value.
    return NextResponse.json(storeProviderKey(provider, body.apiKey), { headers: NO_STORE });
  } catch (err) {
    const expected = appErrorResponse(err, req);
    if (expected) return expected;
    // `err` only: a caught exception from this path could carry the submitted value in a message,
    // and provider is the only field worth binding anyway.
    log.error(
      { event: "provider_key_store_failed", outcome: "key_not_stored", code: "INTERNAL_ERROR", err, provider },
      "failed to store the provider API key",
    );
    return errorResponse("INTERNAL_ERROR", "failed to store the provider API key", { request: req });
  }
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ provider: string }> }) {
  const { provider } = await params;
  try {
    return NextResponse.json(removeProviderKey(provider), { headers: NO_STORE });
  } catch (err) {
    const expected = appErrorResponse(err, req);
    if (expected) return expected;
    log.error(
      { event: "provider_key_delete_failed", outcome: "key_not_deleted", code: "INTERNAL_ERROR", err, provider },
      "failed to delete the provider API key",
    );
    return errorResponse("INTERNAL_ERROR", "failed to delete the provider API key", { request: req });
  }
}
