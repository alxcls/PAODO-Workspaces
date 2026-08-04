// One complete model-selection catalog for UI and programmatic triggers. Provider ids own their model
// and effort lists, avoiding the old split response where callers first received provider names and
// then had to repeat the request with ?provider= before the other fields meant anything.
import { NextResponse } from "next/server";
import { getModelCatalog } from "@/lib/operations/modelCatalog";

export function GET() {
  return NextResponse.json({ providers: getModelCatalog() });
}
