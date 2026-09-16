import { type TenantTx, schema } from "@galm/db";
import { and, eq } from "drizzle-orm";
import { DomainError } from "./errors";

/**
 * Durable "this file belongs to this tenant" record, separate from the raw storage key so
 * the app never has to trust a client-supplied path. Backs both test-step evidence
 * (testStepExecutionId set) and images embedded in any rich-text field (left null -
 * referenced only by id from inside the HTML, resolved through the web app's
 * /api/attachments/[id] route rather than a stored URL, since a stored signed URL would
 * eventually expire).
 */
export async function registerAttachment(
  db: TenantTx,
  params: {
    tenantId: string;
    storageKey: string;
    contentType: string;
    filename: string;
    testStepExecutionId?: string | null;
    createdBy: string;
  },
) {
  const [attachment] = await db
    .insert(schema.attachments)
    .values({
      tenantId: params.tenantId,
      storageKey: params.storageKey,
      contentType: params.contentType,
      filename: params.filename,
      testStepExecutionId: params.testStepExecutionId ?? null,
      createdBy: params.createdBy,
    })
    .returning();
  if (!attachment) throw new DomainError("failed to register attachment");
  return attachment;
}

export async function getAttachment(db: TenantTx, tenantId: string, attachmentId: string) {
  const [attachment] = await db
    .select()
    .from(schema.attachments)
    .where(and(eq(schema.attachments.id, attachmentId), eq(schema.attachments.tenantId, tenantId)));
  if (!attachment) throw new DomainError(`attachment ${attachmentId} not found`);
  return attachment;
}

export async function listEvidenceForStepExecution(db: TenantTx, tenantId: string, testStepExecutionId: string) {
  return db
    .select()
    .from(schema.attachments)
    .where(
      and(
        eq(schema.attachments.tenantId, tenantId),
        eq(schema.attachments.testStepExecutionId, testStepExecutionId),
      ),
    );
}
