import { type TenantTx, schema } from "@galm/db";
import { and, eq } from "drizzle-orm";

/** Kept intentionally generic (not Spira-specific) - the same table backs any future
 * integration that needs "this local row came from that external system" (e.g. Jira,
 * backlog item 8, which also wants bidirectional sync). */
export type ExternalEntityType = "requirement" | "test_case" | "test_step";
export type ExternalSource = "spira";

/** Shared result shape for every importer's create-or-update path (requirements and test
 * cases alike) - "skipped" only ever applies to requirements (an existing one that's moved
 * past Draft; see createOrUpdateRequirementFromImport), test cases never produce it. */
export type ImportUpsertAction = "created" | "updated" | "unchanged" | "skipped";

/** Looks up the local entity id already imported from a given external row, if any - the
 * whole point being idempotent re-import: call this before creating, and update the
 * existing entity instead of creating a duplicate when it returns non-null. */
export async function findEntityIdBySource(
  db: TenantTx,
  params: { tenantId: string; entityType: ExternalEntityType; source: ExternalSource; externalId: string },
): Promise<string | null> {
  const [row] = await db
    .select({ entityId: schema.externalLinks.entityId })
    .from(schema.externalLinks)
    .where(
      and(
        eq(schema.externalLinks.tenantId, params.tenantId),
        eq(schema.externalLinks.entityType, params.entityType),
        eq(schema.externalLinks.source, params.source),
        eq(schema.externalLinks.externalId, params.externalId),
      ),
    );
  return row?.entityId ?? null;
}

/** Bulk variant of findEntityIdBySource - loads every mapping for a given (entityType,
 * source) at once, as externalId -> local entityId, for a "resolve once per run" step
 * rather than one query per row (same idiom as
 * packages/integrations/spira/src/custom-fields.ts's loadCustomFieldMappingResolution).
 * Used by the test case importer to resolve Spira's own requirement trace links against
 * requirements already imported here, without a query per test case per linked
 * requirement. */
export async function listEntityIdsBySource(
  db: TenantTx,
  params: { tenantId: string; entityType: ExternalEntityType; source: ExternalSource },
): Promise<Map<string, string>> {
  const rows = await db
    .select({ externalId: schema.externalLinks.externalId, entityId: schema.externalLinks.entityId })
    .from(schema.externalLinks)
    .where(
      and(
        eq(schema.externalLinks.tenantId, params.tenantId),
        eq(schema.externalLinks.entityType, params.entityType),
        eq(schema.externalLinks.source, params.source),
      ),
    );
  return new Map(rows.map((r) => [r.externalId, r.entityId]));
}

/** Records (or refreshes) the mapping for a newly-created local entity. Upserts on the
 * (tenant, entityType, entityId, source) constraint rather than the (source, externalId)
 * one - the entity is the thing being created here, so it's the side that's new. */
export async function recordExternalLink(
  db: TenantTx,
  params: {
    tenantId: string;
    entityType: ExternalEntityType;
    entityId: string;
    source: ExternalSource;
    externalId: string;
  },
): Promise<void> {
  await db
    .insert(schema.externalLinks)
    .values({
      tenantId: params.tenantId,
      entityType: params.entityType,
      entityId: params.entityId,
      source: params.source,
      externalId: params.externalId,
    })
    .onConflictDoUpdate({
      target: [
        schema.externalLinks.tenantId,
        schema.externalLinks.entityType,
        schema.externalLinks.entityId,
        schema.externalLinks.source,
      ],
      set: { externalId: params.externalId, importedAt: new Date() },
    });
}
