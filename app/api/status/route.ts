export const runtime = "nodejs";

import packageJson from "@/package.json";

export function GET() {
  return Response.json(
    {
      status: "ok",
      service: "PAODO",
      version: packageJson.version,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
