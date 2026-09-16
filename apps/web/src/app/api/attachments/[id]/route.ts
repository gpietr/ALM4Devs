import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { storage } from "@/lib/storage";
import { getAttachment } from "@galm/core";
import { withTenant } from "@galm/db";
import { NextResponse } from "next/server";

/**
 * Session-authenticated, not token-authenticated: a stable, permanent URL that resolves
 * to a freshly-signed storage URL on every request, rather than embedding a signed URL
 * directly in stored rich-text HTML (which would eventually expire). Used both for
 * rich-text embedded images and for downloading test-step evidence.
 */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await auth.api.getSession({ headers: req.headers });
  if (!session) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const tenantId = (session.user as { tenantId?: string }).tenantId;
  if (!tenantId) {
    return NextResponse.json({ error: "no tenant" }, { status: 400 });
  }

  const attachment = await withTenant(db, tenantId, (tx) => getAttachment(tx, tenantId, id)).catch((err) => {
    // Logged rather than silently swallowed: a blind catch-to-null here once masked a
    // real connection-pool exhaustion error as a plain 404, which took a direct DB query
    // to actually diagnose. Still returns 404 either way (a lookup failure and a query
    // failure both mean "can't serve this attachment" to the caller), but now the real
    // cause is visible in the logs instead of looking like a missing row.
    console.error("[attachments] lookup failed:", err);
    return null;
  });
  if (!attachment) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  const signedUrl = await storage.getSignedUrl(attachment.storageKey, { expiresInSeconds: 300 });
  return NextResponse.redirect(new URL(signedUrl, req.url));
}
