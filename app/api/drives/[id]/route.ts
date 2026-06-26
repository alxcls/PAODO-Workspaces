// REST endpoint for a single shared drive.
// PATCH renames it; DELETE removes the drive, its connections, and its files on disk.
import { type NextRequest, NextResponse } from "next/server";
import { getDrive, updateDrive, deleteDrive } from "@/lib/workspace/driveStore";
import { checkRateLimit } from "@/lib/infra/security/rateLimit";
import { getClientIp } from "@/lib/infra/realtime/clientIp";
import { createLogger } from "@/lib/infra/logger";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const drive = getDrive(id);
  if (!drive) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json(drive);
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ip = getClientIp(req);
  const rl = checkRateLimit(ip);
  const { id } = await params;
  if (!rl.ok) {
    createLogger("api").warn({ driveId: id, ip }, "rate limit exceeded");
    return new Response("Too Many Requests", { status: 429, headers: { "Retry-After": String(rl.retryAfter) } });
  }
  const body = (await req.json()) as { name?: string };
  try {
    const drive = updateDrive(id, body);
    if (!drive) return NextResponse.json({ error: "not found" }, { status: 404 });
    return NextResponse.json(drive);
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ip = getClientIp(req);
  const rl = checkRateLimit(ip);
  const { id } = await params;
  if (!rl.ok) {
    createLogger("api").warn({ driveId: id, ip }, "rate limit exceeded");
    return new Response("Too Many Requests", { status: 429, headers: { "Retry-After": String(rl.retryAfter) } });
  }
  const deleted = await deleteDrive(id);
  return NextResponse.json({ deleted });
}
