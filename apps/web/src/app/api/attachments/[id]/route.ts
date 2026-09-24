import { db } from "@/lib/db";
import { storage } from "@/lib/storage";
import { requireActiveUser } from "@/server/tenant-access";
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
  const user = await requireActiveUser(req);
  if (user instanceof Response) return user;
  const { tenantId } = user;

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

  // Pass the registered content type into the signed token so the file route can serve it
  // with an explicit Content-Type instead of letting the browser sniff - see that route's
  // INLINE_SAFE_TYPES for which types are allowed to render in this origin at all.
  const signedUrl = await storage.getSignedUrl(attachment.storageKey, {
    expiresInSeconds: 300,
    contentType: attachment.contentType,
  });
  return NextResponse.redirect(new URL(signedUrl, req.url));
}
