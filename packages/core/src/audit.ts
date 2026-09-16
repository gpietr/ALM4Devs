import { type TenantTx, schema } from "@galm/db";

/** Shared by every domain module that writes a state-changing mutation to the audit
 * log - kept in its own file (like errors.ts) so requirements.ts and test-cases.ts can
 * both import it without depending on each other. */
export async function writeAuditLog(
  db: TenantTx,
  params: {
    tenantId: string;
    actorUserId: string;
    action: string;
    entityType: string;
    entityId: string;
    payload?: Record<string, unknown>;
  },
) {
  await db.insert(schema.auditLog).values({
    tenantId: params.tenantId,
    actorUserId: params.actorUserId,
    action: params.action,
    entityType: params.entityType,
    entityId: params.entityId,
    payload: params.payload ?? null,
  });
}
