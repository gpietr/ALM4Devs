import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { storage } from "@/lib/storage";
import { registerAttachment } from "@galm/core";
import { withTenant } from "@galm/db";
import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";

/**
 * Backs both test-step evidence and images embedded in any rich-text field. Pass
 * `?stepExecutionId=<id>` to associate the upload with a step execution (evidence);
 * omit it for a general rich-text image (referenced only by id from inside the HTML).
 */
export async function POST(req: Request) {
  const session = await auth.api.getSession({ headers: req.headers });
  if (!session) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const user = session.user as { id: string; tenantId?: string };
  if (!user.tenantId) {
    return NextResponse.json({ error: "no tenant" }, { status: 400 });
  }

  const stepExecutionId = new URL(req.url).searchParams.get("stepExecutionId") ?? undefined;
  const contentType = req.headers.get("content-type") ?? "application/octet-stream";
  const filename = req.headers.get("x-filename") ?? "upload";
  const bytes = new Uint8Array(await req.arrayBuffer());

  const storageKey = `${user.tenantId}/${randomUUID()}`;
  await storage.putObject(storageKey, bytes);

  const attachment = await withTenant(db, user.tenantId, (tx) =>
    registerAttachment(tx, {
      tenantId: user.tenantId!,
      storageKey,
      contentType,
      filename,
      testStepExecutionId: stepExecutionId,
      createdBy: user.id,
    }),
  );

  return NextResponse.json({ id: attachment.id, url: `/api/attachments/${attachment.id}` });
}
