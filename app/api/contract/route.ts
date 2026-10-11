// What a programmatic caller may set on each resource, served so its field list is never a copy.
import { NextResponse } from "next/server";
import { getPlatformContract } from "@/lib/operations/contract/fields";

export function GET() {
  return NextResponse.json(getPlatformContract(), { headers: { "Cache-Control": "no-store" } });
}
