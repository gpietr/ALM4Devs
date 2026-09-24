import { NextResponse } from "next/server";

/** Per-file upload ceiling in bytes: `MAX_UPLOAD_MB` (default 100). */
export function maxUploadBytes(): number {
  const parsed = Number(process.env.MAX_UPLOAD_MB);
  return (Number.isFinite(parsed) && parsed > 0 ? parsed : 100) * 1024 * 1024;
}

/**
 * Reads a request body into memory, refusing anything over the limit. Returns the bytes,
 * or a 413 Response. Checks Content-Length up front so an honest oversized upload is
 * rejected before any of it is read, then enforces the cap while streaming so a missing or
 * lying Content-Length can't get past it.
 */
export async function readBodyWithLimit(req: Request): Promise<Uint8Array | Response> {
  const limit = maxUploadBytes();
  const tooLarge = () =>
    NextResponse.json({ error: `file too large (limit ${Math.round(limit / 1024 / 1024)} MB)` }, { status: 413 });

  const declared = Number(req.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) return tooLarge();
  if (!req.body) return new Uint8Array();

  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = req.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      return tooLarge();
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    bytes.set(c, offset);
    offset += c.byteLength;
  }
  return bytes;
}
