import { type NextRequest } from "next/server";

export function getClientIp(req: NextRequest): string {
  return (
    req.headers.get("x-real-ip")?.trim() ??
    req.headers.get("x-forwarded-for")?.split(",").at(-1)?.trim() ??
    "unknown"
  );
}
