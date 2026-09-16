import { auth } from "@/lib/auth";
import { storage } from "@/lib/storage";
import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";

/** Walking-skeleton scope: proves the storage abstraction round-trips a file end to end
 * (backlog item 0, checklist #6). Real evidence-attachment upload UX is backlog item 3. */
export async function POST(req: Request) {
  const session = await auth.api.getSession({ headers: req.headers });
  if (!session) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const tenantId = (session.user as { tenantId?: string }).tenantId ?? "unknown-tenant";
  const bytes = new Uint8Array(await req.arrayBuffer());
  const key = `${tenantId}/${randomUUID()}`;

  await storage.putObject(key, bytes);
  const url = await storage.getSignedUrl(key, { expiresInSeconds: 300 });

  return NextResponse.json({ key, url });
}
