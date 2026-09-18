import { type TenantTx, schema } from "@galm/db";
import { and, desc, eq, inArray } from "drizzle-orm";
import { writeAuditLog } from "./audit";
import { DomainError } from "./errors";
import { isUniqueViolation } from "./level-sequences";

/**
 * A product's own release train ("v1.0", "v1.1", ...) - distinct from
 * requirementVersions/architectureNodeVersions, which track revisions of one item's
 * *content*, not the product's ship history. `SoftwareVersionEntityType` names the three
 * kinds of thing that can be tagged as "applies to this release": requirements, test
 * cases, and OTS component versions (architecture_node_versions rows, e.g. "Log4j
 * 2.14.1"). See schema.ts's softwareVersions/softwareVersionLinks docstrings for why the
 * link table is polymorphic rather than three near-identical join tables.
 */
export type SoftwareVersionEntityType = "requirement" | "test_case" | "architecture_node_version";

export interface SoftwareVersionView {
  id: string;
  versionNumber: string;
  description: string | null;
  releaseDate: Date | null;
  createdAt: Date;
}

const SOFTWARE_VERSION_COLUMNS = {
  id: schema.softwareVersions.id,
  versionNumber: schema.softwareVersions.versionNumber,
  description: schema.softwareVersions.description,
  releaseDate: schema.softwareVersions.releaseDate,
  createdAt: schema.softwareVersions.createdAt,
};

export async function listSoftwareVersions(
  db: TenantTx,
  tenantId: string,
  productId: string,
): Promise<SoftwareVersionView[]> {
  return db
    .select(SOFTWARE_VERSION_COLUMNS)
    .from(schema.softwareVersions)
    .where(and(eq(schema.softwareVersions.tenantId, tenantId), eq(schema.softwareVersions.productId, productId)))
    .orderBy(desc(schema.softwareVersions.releaseDate), desc(schema.softwareVersions.createdAt));
}

export async function createSoftwareVersion(
  db: TenantTx,
  params: {
    tenantId: string;
    productId: string;
    versionNumber: string;
    description?: string;
    releaseDate?: Date;
    createdBy: string;
  },
): Promise<SoftwareVersionView> {
  const versionNumber = params.versionNumber.trim();
  if (!versionNumber) throw new DomainError("version number is required");

  let row: SoftwareVersionView | undefined;
  try {
    [row] = await db
      .insert(schema.softwareVersions)
      .values({
        tenantId: params.tenantId,
        productId: params.productId,
        versionNumber,
        description: params.description?.trim() || null,
        releaseDate: params.releaseDate ?? null,
        createdBy: params.createdBy,
      })
      .returning(SOFTWARE_VERSION_COLUMNS);
  } catch (err) {
    if (isUniqueViolation(err)) throw new DomainError("a version with this number already exists");
    throw err;
  }
  if (!row) throw new DomainError("failed to create software version");

  await writeAuditLog(db, {
    tenantId: params.tenantId,
    actorUserId: params.createdBy,
    action: "software_version.created",
    entityType: "software_version",
    entityId: row.id,
    payload: { versionNumber },
  });
  return row;
}

export async function updateSoftwareVersion(
  db: TenantTx,
  params: {
    tenantId: string;
    id: string;
    versionNumber: string;
    description?: string;
    releaseDate?: Date | null;
    editedBy: string;
  },
): Promise<SoftwareVersionView> {
  const versionNumber = params.versionNumber.trim();
  if (!versionNumber) throw new DomainError("version number is required");

  let row: SoftwareVersionView | undefined;
  try {
    [row] = await db
      .update(schema.softwareVersions)
      .set({
        versionNumber,
        description: params.description?.trim() || null,
        releaseDate: params.releaseDate ?? null,
      })
      .where(and(eq(schema.softwareVersions.id, params.id), eq(schema.softwareVersions.tenantId, params.tenantId)))
      .returning(SOFTWARE_VERSION_COLUMNS);
  } catch (err) {
    if (isUniqueViolation(err)) throw new DomainError("a version with this number already exists");
    throw err;
  }
  if (!row) throw new DomainError("software version not found");

  await writeAuditLog(db, {
    tenantId: params.tenantId,
    actorUserId: params.editedBy,
    action: "software_version.updated",
    entityType: "software_version",
    entityId: row.id,
    payload: { versionNumber },
  });
  return row;
}

export async function deleteSoftwareVersion(
  db: TenantTx,
  params: { tenantId: string; id: string; deletedBy: string },
): Promise<void> {
  const [row] = await db
    .delete(schema.softwareVersions)
    .where(and(eq(schema.softwareVersions.id, params.id), eq(schema.softwareVersions.tenantId, params.tenantId)))
    .returning({ id: schema.softwareVersions.id, versionNumber: schema.softwareVersions.versionNumber });
  if (!row) throw new DomainError("software version not found");

  await writeAuditLog(db, {
    tenantId: params.tenantId,
    actorUserId: params.deletedBy,
    action: "software_version.deleted",
    entityType: "software_version",
    entityId: row.id,
    payload: { versionNumber: row.versionNumber },
  });
}

/** Rejects any id that doesn't belong to `productId` - the same "can't link across
 * products" guard as assertSameProductArchitectureNodes (architecture.ts), applied here
 * so a requirement/test case/OTS version can only be tagged with versions from its own
 * product. */
async function assertSameProductSoftwareVersions(
  db: TenantTx,
  tenantId: string,
  productId: string,
  softwareVersionIds: string[],
): Promise<void> {
  if (softwareVersionIds.length === 0) return;
  const unique = [...new Set(softwareVersionIds)];
  const rows = await db
    .select({ id: schema.softwareVersions.id, productId: schema.softwareVersions.productId })
    .from(schema.softwareVersions)
    .where(and(eq(schema.softwareVersions.tenantId, tenantId), inArray(schema.softwareVersions.id, unique)));
  if (rows.length !== unique.length) {
    throw new DomainError("one or more software versions were not found");
  }
  if (rows.some((r) => r.productId !== productId)) {
    throw new DomainError("linked software versions must belong to the same product");
  }
}

/** Replace-all write for "which software versions does this apply to" - same
 * delete-then-insert shape as replaceRequirementArchitectureLinks/
 * replaceTestCaseArchitectureLinks (architecture.ts). `productId` is the entity's own
 * product, used only to validate `softwareVersionIds` against - it's never stored on the
 * link row itself. */
export async function replaceSoftwareVersionLinks(
  db: TenantTx,
  params: {
    tenantId: string;
    entityType: SoftwareVersionEntityType;
    entityId: string;
    productId: string;
    softwareVersionIds: string[];
  },
): Promise<void> {
  await assertSameProductSoftwareVersions(db, params.tenantId, params.productId, params.softwareVersionIds);
  await db
    .delete(schema.softwareVersionLinks)
    .where(
      and(
        eq(schema.softwareVersionLinks.tenantId, params.tenantId),
        eq(schema.softwareVersionLinks.entityType, params.entityType),
        eq(schema.softwareVersionLinks.entityId, params.entityId),
      ),
    );
  const unique = [...new Set(params.softwareVersionIds)];
  if (unique.length === 0) return;
  await db.insert(schema.softwareVersionLinks).values(
    unique.map((softwareVersionId) => ({
      tenantId: params.tenantId,
      softwareVersionId,
      entityType: params.entityType,
      entityId: params.entityId,
    })),
  );
}

export interface SoftwareVersionLinkView {
  id: string;
  versionNumber: string;
}

/** The software versions currently tagged on one requirement/test case/OTS version -
 * for display next to that entity (its own detail page, or a compact row in a list). */
export async function listSoftwareVersionsForEntity(
  db: TenantTx,
  tenantId: string,
  entityType: SoftwareVersionEntityType,
  entityId: string,
): Promise<SoftwareVersionLinkView[]> {
  return db
    .select({ id: schema.softwareVersions.id, versionNumber: schema.softwareVersions.versionNumber })
    .from(schema.softwareVersionLinks)
    .innerJoin(schema.softwareVersions, eq(schema.softwareVersionLinks.softwareVersionId, schema.softwareVersions.id))
    .where(
      and(
        eq(schema.softwareVersionLinks.tenantId, tenantId),
        eq(schema.softwareVersionLinks.entityType, entityType),
        eq(schema.softwareVersionLinks.entityId, entityId),
      ),
    )
    .orderBy(desc(schema.softwareVersions.releaseDate), desc(schema.softwareVersions.createdAt));
}

/** Same as listSoftwareVersionsForEntity, batched over many entities at once - for a
 * list view's columns/filters, one query for the whole page rather than one per row (see
 * getCustomFieldValuesForEntities in custom-fields.ts, same shape: a Map pre-seeded with
 * `[]` for every id, so a caller never has to null-check a missing entry). */
export async function listSoftwareVersionsForEntities(
  db: TenantTx,
  tenantId: string,
  entityType: SoftwareVersionEntityType,
  entityIds: string[],
): Promise<Map<string, SoftwareVersionLinkView[]>> {
  const result = new Map<string, SoftwareVersionLinkView[]>(entityIds.map((id) => [id, []]));
  if (entityIds.length === 0) return result;

  const rows = await db
    .select({
      entityId: schema.softwareVersionLinks.entityId,
      id: schema.softwareVersions.id,
      versionNumber: schema.softwareVersions.versionNumber,
    })
    .from(schema.softwareVersionLinks)
    .innerJoin(schema.softwareVersions, eq(schema.softwareVersionLinks.softwareVersionId, schema.softwareVersions.id))
    .where(
      and(
        eq(schema.softwareVersionLinks.tenantId, tenantId),
        eq(schema.softwareVersionLinks.entityType, entityType),
        inArray(schema.softwareVersionLinks.entityId, entityIds),
      ),
    )
    .orderBy(desc(schema.softwareVersions.releaseDate), desc(schema.softwareVersions.createdAt));

  for (const { entityId, ...version } of rows) {
    result.get(entityId)!.push(version);
  }
  return result;
}
