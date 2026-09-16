import { storage } from "@/lib/storage";
import { verifySignedToken } from "@galm/storage";
import { readFile } from "node:fs/promises";
import { NextResponse } from "next/server";

export async function GET(_req: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  try {
    const secret = process.env.STORAGE_SIGNING_SECRET ?? "dev-only-insecure-secret";
    const key = verifySignedToken(token, secret);
    const path = storage.resolveForVerification(key);
    const data = await readFile(path);
    return new NextResponse(new Uint8Array(data));
  } catch {
    return NextResponse.json({ error: "invalid or expired token" }, { status: 403 });
  }
}
