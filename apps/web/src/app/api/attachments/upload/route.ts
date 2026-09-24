import { db } from "@/lib/db";
import { storage } from "@/lib/storage";
import { requireActiveUser } from "@/server/tenant-access";
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
  const user = await requireActiveUser(req);
  if (user instanceof Response) return user;

  const stepExecutionId = new URL(req.url).searchParams.get("stepExecutionId") ?? undefined;
  const contentType = req.headers.get("content-type") ?? "application/octet-stream";
  const filename = req.headers.get("x-filename") ?? "upload";
  const bytes = new Uint8Array(await req.arrayBuffer());

  const storageKey = `${user.tenantId}/${randomUUID()}`;
  await storage.putObject(storageKey, bytes);

  const attachment = await withTenant(db, user.tenantId, (tx) =>
    registerAttachment(tx, {
      tenantId: user.tenantId,
      storageKey,
      contentType,
      filename,
      testStepExecutionId: stepExecutionId,
      createdBy: user.id,
    }),
  );

  return NextResponse.json({ id: attachment.id, url: `/api/attachments/${attachment.id}` });
}
