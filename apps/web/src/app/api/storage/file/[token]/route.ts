import { storage } from "@/lib/storage";
import { verifySignedToken } from "@galm/storage";
import { readFile } from "node:fs/promises";
import { NextResponse } from "next/server";

/**
 * Types we're willing to render inline in this origin. Everything else is forced to
 * download, because this route serves user-uploaded bytes from the *app's own* origin -
 * so anything the browser agrees to execute here (HTML, SVG - which can carry <script> -
 * or an XML/XSLT document) runs with full access to the signed-in user's session. SVG is
 * excluded for exactly that reason even though it's an image.
 */
const INLINE_SAFE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/avif",
  "image/bmp",
  "image/x-icon",
  "application/pdf",
  "text/plain",
]);

export async function GET(_req: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  try {
    const secret = process.env.STORAGE_SIGNING_SECRET ?? "dev-only-insecure-secret";
    const { key, contentType } = verifySignedToken(token, secret);
    const path = storage.resolveForVerification(key);
    const data = await readFile(path);

    const inline = contentType !== null && INLINE_SAFE_TYPES.has(contentType.toLowerCase().split(";")[0]!.trim());
    return new NextResponse(new Uint8Array(data), {
      headers: {
        // Always an explicit type. Serving with none at all let the browser sniff, which
        // turned an uploaded .html attachment into stored XSS in this origin.
        "Content-Type": inline && contentType ? contentType : "application/octet-stream",
        // Belt to that: forbids sniffing even where the declared type is wrong.
        "X-Content-Type-Options": "nosniff",
        // Anything not on the inline allowlist downloads instead of rendering.
        ...(inline ? {} : { "Content-Disposition": "attachment" }),
        // Private: these URLs are bearer credentials with a short life; shared caches
        // must not hold on to the bytes behind them.
        "Cache-Control": "private, max-age=60",
      },
    });
  } catch {
    return NextResponse.json({ error: "invalid or expired token" }, { status: 403 });
  }
}
