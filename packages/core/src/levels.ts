import { type TenantTx, schema } from "@galm/db";
import { and, asc, eq, sql } from "drizzle-orm";
import { DomainError } from "./errors";
import { normalizeLevelCode, rethrowDuplicateLevelCode } from "./level-sequences";

/**
 * Shared implementation behind both requirement levels and test-case levels -
 * requirement-levels.ts and test-levels.ts are now thin `kind`-bound wrappers over this
 * file, kept as separate modules only so every existing call site (routers, the register
 * route, the tenant-defaults backfill script) keeps its original, kind-specific function
 * names rather than threading a `kind` argument through the whole app. See
 * packages/db/src/schema.ts's `levels` table docstring for why requirement levels and
 * test levels are one physical table now, not two.
 */
export type LevelKind = "requirement" | "test";

function noun(kind: LevelKind): string {
  return kind === "requirement" ? "level" : "test level";
}

/** Count of requirements/test cases (matching `kind`) currently using a level - the one
 * check shared by updateLevelCodeOfKind (code changes refused once non-zero) and
 * deleteLevelOfKind (deletion refused once non-zero). Written as an explicit branch per
 * kind, not a table reference passed around, so each branch stays fully typed against its
 * own table instead of a widened union type. */
async function countItemsUsingLevel(db: TenantTx, tenantId: string, kind: LevelKind, levelId: string): Promise<number> {
  if (kind === "requirement") {
    const [row] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(schema.requirements)
      .where(and(eq(schema.requirements.levelId, levelId), eq(schema.requirements.tenantId, tenantId)));
    return row?.count ?? 0;
  }
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(schema.testCases)
    .where(and(eq(schema.testCases.levelId, levelId), eq(schema.testCases.tenantId, tenantId)));
  return row?.count ?? 0;
}

/** Called once, right after a tenant is created (see apps/web/src/app/api/register). */
export async function seedLevels(
  db: TenantTx,
  tenantId: string,
  kind: LevelKind,
  defaults: ReadonlyArray<{ name: string; code: string; sortOrder: number }>,
) {
  return db
    .insert(schema.levels)
    .values(defaults.map((l) => ({ tenantId, kind, ...l })))
    .returning();
}

export async function listLevelsOfKind(db: TenantTx, tenantId: string, kind: LevelKind) {
  return db
    .select()
    .from(schema.levels)
    .where(and(eq(schema.levels.tenantId, tenantId), eq(schema.levels.kind, kind)))
    .orderBy(asc(schema.levels.sortOrder));
}

export async function getLevelOfKind(db: TenantTx, tenantId: string, kind: LevelKind, levelId: string) {
  const [level] = await db
    .select()
    .from(schema.levels)
    .where(and(eq(schema.levels.id, levelId), eq(schema.levels.tenantId, tenantId), eq(schema.levels.kind, kind)));
  if (!level) throw new DomainError(`${noun(kind)} ${levelId} not found`);
  return level;
}

export async function createLevelOfKind(db: TenantTx, tenantId: string, kind: LevelKind, name: string, code: string) {
  const existing = await listLevelsOfKind(db, tenantId, kind);
  const nextSortOrder = existing.length > 0 ? Math.max(...existing.map((l) => l.sortOrder)) + 1 : 0;
  const [level] = await db
    .insert(schema.levels)
    .values({ tenantId, kind, name, code: normalizeLevelCode(code), sortOrder: nextSortOrder })
    .returning()
    .catch(rethrowDuplicateLevelCode);
  if (!level) throw new DomainError(`failed to create ${noun(kind)}`);
  return level;
}

export async function renameLevelOfKind(db: TenantTx, tenantId: string, kind: LevelKind, levelId: string, name: string) {
  await getLevelOfKind(db, tenantId, kind, levelId);
  const [updated] = await db
    .update(schema.levels)
    .set({ name })
    .where(and(eq(schema.levels.id, levelId), eq(schema.levels.tenantId, tenantId), eq(schema.levels.kind, kind)))
    .returning();
  if (!updated) throw new DomainError("rename failed");
  return updated;
}

/** The id-prefix code is a separate mutation from the display name (renameLevelOfKind) - a
 * team might fix a typo in one without touching the other. Refused once any requirement/
 * test case has been created under the level: a code isn't just cosmetic once it's been
 * used - it's the prefix on ids that may already be printed on a signed approval, an
 * exported traceability matrix, or a Jira/Spira cross-reference, none of which get
 * rewritten retroactively. Renaming a still-empty level (the common case - fixing a typo
 * right after creating it) stays unrestricted. */
export async function updateLevelCodeOfKind(db: TenantTx, tenantId: string, kind: LevelKind, levelId: string, code: string) {
  await getLevelOfKind(db, tenantId, kind, levelId);

  const count = await countItemsUsingLevel(db, tenantId, kind, levelId);
  if (count > 0) {
    const itemNounPlural = kind === "requirement" ? "requirements" : "test cases";
    throw new DomainError(
      `cannot change the code of a ${noun(kind)} that already has ${itemNounPlural} using it - ` +
        `ids already assigned under it may already be exported, signed, or cross-referenced elsewhere`,
    );
  }

  const [updated] = await db
    .update(schema.levels)
    .set({ code: normalizeLevelCode(code) })
    .where(and(eq(schema.levels.id, levelId), eq(schema.levels.tenantId, tenantId), eq(schema.levels.kind, kind)))
    .returning()
    .catch(rethrowDuplicateLevelCode);
  if (!updated) throw new DomainError("updating the code failed");
  return updated;
}

/** Swaps sort_order with the adjacent level. For kind='requirement' this genuinely changes
 * hierarchy behavior (a requirement's valid parents are computed from sortOrder); for
 * kind='test' it's cosmetic display order only. */
export async function reorderLevelOfKind(db: TenantTx, tenantId: string, kind: LevelKind, levelId: string, direction: "up" | "down") {
  const all = await listLevelsOfKind(db, tenantId, kind);
  const index = all.findIndex((l) => l.id === levelId);
  if (index === -1) throw new DomainError(`${noun(kind)} ${levelId} not found`);

  const swapIndex = direction === "up" ? index - 1 : index + 1;
  if (swapIndex < 0 || swapIndex >= all.length) return all;

  const current = all[index]!;
  const other = all[swapIndex]!;
  await db.update(schema.levels).set({ sortOrder: other.sortOrder }).where(eq(schema.levels.id, current.id));
  await db.update(schema.levels).set({ sortOrder: current.sortOrder }).where(eq(schema.levels.id, other.id));

  return listLevelsOfKind(db, tenantId, kind);
}

export async function deleteLevelOfKind(db: TenantTx, tenantId: string, kind: LevelKind, levelId: string) {
  const all = await listLevelsOfKind(db, tenantId, kind);
  if (all.length <= 1) {
    throw new DomainError(`cannot delete the only remaining ${noun(kind)} - at least one is required`);
  }
  await getLevelOfKind(db, tenantId, kind, levelId);

  const count = await countItemsUsingLevel(db, tenantId, kind, levelId);
  if (count > 0) {
    const itemNoun = kind === "requirement" ? "requirement" : "test case";
    const itemNounPlural = kind === "requirement" ? "requirements" : "test cases";
    throw new DomainError(
      `cannot delete a ${noun(kind)} that has ${itemNounPlural} using it (${count} ${count === 1 ? itemNoun : itemNounPlural})`,
    );
  }

  await db
    .delete(schema.levels)
    .where(and(eq(schema.levels.id, levelId), eq(schema.levels.tenantId, tenantId), eq(schema.levels.kind, kind)));
}
