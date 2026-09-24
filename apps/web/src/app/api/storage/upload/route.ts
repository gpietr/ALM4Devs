import { storage } from "@/lib/storage";
import { requireActiveUser } from "@/server/tenant-access";
import { readBodyWithLimit } from "@/server/upload-limit";
import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";

/** Walking-skeleton scope: proves the storage abstraction round-trips a file end to end
 * (backlog item 0, checklist #6). Real evidence-attachment upload UX is backlog item 3. */
export async function POST(req: Request) {
  const user = await requireActiveUser(req);
  if (user instanceof Response) return user;

  const bytes = await readBodyWithLimit(req);
  if (bytes instanceof Response) return bytes;
  // No "unknown-tenant" fallback any more: requireActiveUser rejects a session without a
  // tenantId outright, so this prefix is always a real tenant's.
  const key = `${user.tenantId}/${randomUUID()}`;

  await storage.putObject(key, bytes);
  const url = await storage.getSignedUrl(key, { expiresInSeconds: 300 });

  return NextResponse.json({ key, url });
}
